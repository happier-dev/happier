import { posix, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import type { LanguageIntelligenceDiagnostic } from '@happier-dev/protocol/machines/languageIntelligence';
import type { PluginProcessHandle, PluginProcessOutput } from '@happier-dev/plugin-sdk/exec';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type { HappierProcessRootSource } from '@/daemon/processes/roots/listHappierProcessRoots';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { ProcessOwnerRef } from '@/processes/ownerTag';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { LanguageServerDefinition } from './languageServerDefinitions';
import { createLanguageServerManagedExecAcquirer,
    type AcquireLanguageServerManagedExec, type LanguageServerManagedExec } from './managedProtocol';
import { resolveWorkspacePath, workspaceUriToPath } from './workspaceUris';

export type LanguageServerProjectCheckInput = Readonly<{
    definition: LanguageServerDefinition;
    rootPath: string;
    processOwner: ProcessOwnerRef;
    signal: AbortSignal;
    platform?: NodeJS.Platform;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
}>;
export type LanguageServerProjectCheckResult =
    | Readonly<{ status: 'completed'; diagnostics: LanguageIntelligenceDiagnostic[] }>
    | Readonly<{ status: 'failed'; reason: 'server_missing' | 'start_failed' | 'invalid_response' | 'request_failed' }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'unsupported' }>;

/** Decode the declared compiler format incrementally, independently of custody buffers. */
function createOutputDecoder(input: LanguageServerProjectCheckInput) {
    const platform = input.platform ?? process.platform;
    const api = platform === 'win32' ? win32 : posix;
    const context = { rootPath: input.rootPath, platform };
    const diagnostics: LanguageIntelligenceDiagnostic[] = [];
    // A compiler emits many diagnostics per file. Resolve each distinct output
    // path once in this finite projection; every later file open reauthorizes it.
    const paths = new Map<string, string>();
    let invalid = false;
    const streams = new Map<PluginProcessOutput['stream'], {
        decoder: StringDecoder; pending: string; current?: LanguageIntelligenceDiagnostic;
    }>();

    function line(text: string, stream: { current?: LanguageIntelligenceDiagnostic }) {
        if (!text.trim()) return;
        // The path capture is greedy: native paths may contain colons and parentheses.
        const file = /^(.*)\((\d+),(\d+)\): (error|warning) TS(\d+): (.*)$/u.exec(text);
        const project = file ? null : /^(error|warning) TS(\d+): (.*)$/u.exec(text);
        if (!file && !project) {
            if (stream.current) stream.current.message += `\n${text}`;
            else invalid = true;
            return;
        }
        try {
            const sourcePath = file?.[1] ?? input.definition.projectCheck!.projectFile;
            let path = paths.get(sourcePath);
            if (path === undefined) {
                const absolute = api.resolve(input.rootPath, sourcePath);
                const mapped = workspaceUriToPath(context, pathToFileURL(absolute, { windows: platform === 'win32' }).href);
                if (mapped.outsideWorkspace || !mapped.path) throw new Error('Diagnostic outside the workspace');
                path = mapped.path;
                paths.set(sourcePath, path);
            }
            const line = file ? Number(file[2]) - 1 : 0;
            const character = file ? Number(file[3]) - 1 : 0;
            if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0)
                throw new Error('Invalid diagnostic position');
            const position = { line, character };
            stream.current = {
                serverId: input.definition.id, path,
                range: { start: position, end: position },
                severity: (file?.[4] ?? project![1]) === 'warning' ? 'warning' : 'error',
                code: `TS${file?.[5] ?? project![2]}`, source: input.definition.title,
                message: file?.[6] ?? project![3],
            };
            diagnostics.push(stream.current);
        } catch {
            invalid = true;
            stream.current = undefined;
        }
    }

    function consume(stream: { pending: string; current?: LanguageIntelligenceDiagnostic }, text: string) {
        const parts = (stream.pending + text).split('\n');
        stream.pending = parts.pop()!;
        for (const part of parts) line(part.replace(/\r$/u, ''), stream);
    }
    return {
        output(output: PluginProcessOutput) {
            let stream = streams.get(output.stream);
            if (!stream) {
                stream = { decoder: new StringDecoder('utf8'), pending: '' };
                streams.set(output.stream, stream);
            }
            consume(stream, stream.decoder.write(Buffer.from(output.data)));
        },
        finish() {
            for (const stream of streams.values()) {
                consume(stream, stream.decoder.end());
                if (stream.pending) line(stream.pending.replace(/\r$/u, ''), stream);
            }
            return { diagnostics, invalid };
        },
    };
}

export function createLanguageServerProjectChecker(options: Readonly<{
    acquireExec?: AcquireLanguageServerManagedExec;
    acquireRuntimeRegistry?: () => Promise<PluginRuntimeRegistryLease>;
}> = {}) {
    const acquireExec = options.acquireExec ?? createLanguageServerManagedExecAcquirer({
        acquireRuntimeRegistry: options.acquireRuntimeRegistry ?? (() => pluginReloadController.acquireRuntimeRegistry()),
    });
    const processes = new Map<PluginProcessHandle, LanguageServerProjectCheckInput>();
    return {
        readProcessRoots(): readonly HappierProcessRootSource[] {
            return [...processes].flatMap(([handle, input]) => {
                const pid = readSupervisedPluginProcessIdForHost(handle);
                return pid === null ? [] : [{ owner: input.processOwner, pid, workspacePath: input.rootPath, live: true,
                    ...(input.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: input.requesterWorkAttributionV1 } : {}) }];
            });
        },
        async run(input: LanguageServerProjectCheckInput): Promise<LanguageServerProjectCheckResult> {
            const declaration = input.definition.projectCheck;
            if (!declaration) return { status: 'unsupported' };
            let managed: LanguageServerManagedExec | undefined;
            let handle: PluginProcessHandle | undefined;
            let subscription: ReturnType<PluginProcessHandle['onOutput']> | undefined;
            try {
                input.signal.throwIfAborted();
                resolveWorkspacePath(input, declaration.projectFile);
                const output = createOutputDecoder(input);
                managed = await acquireExec({ ...input,
                    definition: { ...input.definition, executable: declaration.executable, args: declaration.args } });
                handle = await managed.service.spawn({ executable: declaration.executable,
                    args: declaration.args, cwd: input.rootPath, stdin: new Uint8Array() });
                subscription = handle.onOutput(output.output);
                processes.set(handle, input);
                invalidateProcessLaunchDiscovery();
                const result = await handle.wait();
                if (managed.signal.aborted || result.termination.requestedBy.kind === 'abort') return { status: 'cancelled' };
                if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit')
                    return { status: 'failed', reason: 'request_failed' };
                const decoded = output.finish();
                if (decoded.invalid || result.termination.observed.exitCode !== 0 && decoded.diagnostics.length === 0)
                    return { status: 'failed', reason: 'invalid_response' };
                return { status: 'completed', diagnostics: decoded.diagnostics };
            } catch (error) {
                if (input.signal.aborted || managed?.signal.aborted) return { status: 'cancelled' };
                return { status: 'failed', reason: isPluginError(error) && error.code === 'server_missing' ? 'server_missing' : 'start_failed' };
            } finally {
                try { await handle?.dispose(); }
                finally {
                    subscription?.dispose();
                    if (handle) { processes.delete(handle); invalidateProcessLaunchDiscovery(); }
                    await managed?.release();
                }
            }
        },
    };
}

const projectChecker = createLanguageServerProjectChecker();
export const runLanguageServerProjectCheck = projectChecker.run;
export const readLanguageServerProjectCheckProcessRoots = projectChecker.readProcessRoots;
