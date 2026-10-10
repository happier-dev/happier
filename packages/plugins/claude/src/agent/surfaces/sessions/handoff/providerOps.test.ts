import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeHandoffSurface } from '@happier-dev/plugin-sdk/agents/runtime';

import { claudeHandoffSurface } from './providerOps.js';

const roots: string[] = [];

// The surface reads `process.env` directly, so the invocation context only has to
// carry the cancellation facts the host supplies at operation time.
function invocation() {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 1024 * 1024,
    };
}

describe('claudeHandoffSurface', () => {
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('reports handoff unavailable for a blank vendor session id', () => {
        expect(claudeHandoffSurface.evaluateAvailability?.(
            { operation: 'exportBundle', sessionId: '   \n ' },
            invocation(),
        )).toEqual({ available: false, reasonCode: 'missing_metadata' });
    });

    it('resolves existing native state in the target environment without copying or re-homing it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-existing-handoff-'));
        roots.push(root);
        const configDir = join(root, 'target-claude');
        const projectId = '-original-project';
        const transcriptPath = join(configDir, 'projects', projectId, 'exact-session.jsonl');
        const content = '{"type":"user","message":"already on target"}\n';
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(transcriptPath, content);
        const surface: AgentRuntimeHandoffSurface = claudeHandoffSurface;
        expect(surface.resolveExistingState).toBeTypeOf('function');
        const result = await surface.resolveExistingState?.({
            sessionId: 'exact-session',
            metadata: { externalSessionSource: { kind: 'claudeConfig', configDir: '/source-only', projectId } },
            targetDirectory: '/different-target-project',
            environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
        }, invocation());
        expect(result).toMatchObject({
            ok: true,
            value: {
                providerSessionId: 'exact-session',
                source: { kind: 'claudeConfig', configDir, projectId },
                launch: { directory: '/different-target-project', environmentVariables: { CLAUDE_CONFIG_DIR: configDir } },
            },
        });
        expect(await readFile(transcriptPath, 'utf8')).toBe(content);
        expect(await readdir(join(configDir, 'projects'))).toEqual([projectId]);
    });

    it('resolves the exact native session after its target project has been re-homed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-existing-missing-'));
        roots.push(root);
        const configDir = join(root, 'target-claude');
        await mkdir(join(configDir, 'projects', '-unrelated'), { recursive: true });
        await writeFile(join(configDir, 'projects', '-unrelated', 'same-id.jsonl'), '{}\n');
        const surface: AgentRuntimeHandoffSurface = claudeHandoffSurface;
        expect(surface.resolveExistingState).toBeTypeOf('function');
        expect(await surface.resolveExistingState?.({
            sessionId: 'same-id',
            metadata: { externalSessionSource: { kind: 'claudeConfig', projectId: '-original-project' } },
            targetDirectory: '/target',
            environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
        }, invocation())).toMatchObject({
            ok: true,
            value: { providerSessionId: 'same-id', source: { kind: 'claudeConfig', configDir, projectId: '-unrelated' } },
        });
        expect(await readdir(join(configDir, 'projects'))).toEqual(['-unrelated']);
        expect(await surface.resolveExistingState?.({
            sessionId: 'absent-session',
            metadata: { externalSessionSource: { kind: 'claudeConfig', projectId: '-original-project' } },
            targetDirectory: '/target',
            environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
        }, invocation())).toMatchObject({ ok: false, code: 'existing_session_state_unavailable' });
        expect(await readdir(join(configDir, 'projects', '-unrelated'))).toEqual(['same-id.jsonl']);
    });

    it('does not resurrect a daemon config override omitted from the effective target environment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-existing-env-'));
        roots.push(root);
        const daemonConfig = join(root, 'daemon-claude');
        const targetHome = join(root, 'target-home');
        await mkdir(join(daemonConfig, 'projects', '-daemon'), { recursive: true });
        await mkdir(targetHome);
        await writeFile(join(daemonConfig, 'projects', '-daemon', 'same-id.jsonl'), '{}\n');
        // The process environment is an OS boundary; native lookup remains real.
        vi.stubEnv('CLAUDE_CONFIG_DIR', daemonConfig);
        const surface: AgentRuntimeHandoffSurface = claudeHandoffSurface;
        expect(await surface.resolveExistingState?.({
            sessionId: 'same-id',
            metadata: {},
            targetDirectory: '/target',
            environmentVariables: { HOME: targetHome, USERPROFILE: targetHome },
        }, invocation())).toMatchObject({ ok: false, code: 'existing_session_state_unavailable' });
        expect(await readdir(targetHome)).toEqual([]);
        expect(await readFile(join(daemonConfig, 'projects', '-daemon', 'same-id.jsonl'), 'utf8')).toBe('{}\n');
    });

    it('exports the transcript that belongs to the vendor session id, byte for byte', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-exact-id-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectId = '-work-demo';
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(
            join(configDir, 'projects', projectId, 'padded-session.jsonl'),
            '{"type":"user"}\n',
            'utf8',
        );
        // The linked source carries the config dir, so this stays off the
        // process-global environment that sibling suites share.
        const metadata = {
            path: '/work/demo',
            externalSessionSource: { kind: 'claudeConfig', configDir, projectId },
        };

        // `padded-session` is a different session from `  padded-session  `; the
        // padded request must not export the former's transcript under the latter's id.
        const padded = await claudeHandoffSurface.exportBundle(
            { sessionId: '  padded-session  ', metadata, directory: root },
            invocation(),
        );
        expect(padded.ok).toBe(false);

        const exact = await claudeHandoffSurface.exportBundle(
            { sessionId: 'padded-session', metadata, directory: root },
            invocation(),
        );
        expect(exact.ok).toBe(true);
        expect(exact.ok ? exact.value.bundle.remoteSessionId : null).toBe('padded-session');
    });
});
