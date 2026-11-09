import { readFile, writeFile } from 'node:fs/promises';
import { addAbortSignal } from 'node:stream';

import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';

import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { assertCommandArguments, argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';
import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';

import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { type ActionCliExecutionDeps, describeCompiledActionCliCommandArgvPolicy, runCompiledActionCliCommand } from './executeCommand';
import { buildActionCliHelpModel, renderActionCliHelpModel } from './commandHelp';

type WorkflowDocumentCommandDeps = Readonly<{
  readFileFn: (path: string) => Promise<string | Uint8Array>;
  readStdinFn: (signal?: AbortSignal) => Promise<string | Uint8Array>;
  writeFileFn: (path: string, content: string) => Promise<void>;
  actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>;

const DEFAULT_DEPS: WorkflowDocumentCommandDeps = {
  readFileFn: readFile,
  readStdinFn: async (signal) => {
    signal?.throwIfAborted();
    const chunks: Uint8Array[] = [];
    for await (const chunk of signal ? addAbortSignal(signal, process.stdin) : process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  },
  writeFileFn: async (path, content) => writeFile(path, content, 'utf8'),
};

function decodeUtf8(content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new TypeError('Workflow document is not valid UTF-8', { cause: error });
  }
}

function commandFor(path: readonly string[]) {
  const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
  if (!command || command.path.join(' ') !== path.join(' ')) {
    throw new Error(`Missing canonical Action command: ${path.join(' ')}`);
  }
  return command;
}

async function reportError(
  argv: readonly string[],
  kind: string,
  code: string,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  if (argvBeforeOptionTerminator(argv).includes('--json')) {
    await printJsonEnvelope({
      ok: false,
      kind,
      error: { code, ...fields },
    }, { exitCode: 1 });
    return;
  }
  console.error(`Error: ${code}`);
  process.exitCode = 1;
}

function positionalAt(argv: readonly string[], index: number): string | null {
  const value = argv[index];
  return value && !value.startsWith('--') ? value : null;
}

/**
 * Thin file boundary for the canonical workflow definition Actions. The file
 * wrapper is parsed/serialized by Protocol; auth, encryption, CAS and remote
 * execution remain in the ordinary compiled Action path.
 */
export async function tryHandleWorkflowDocumentCliCommand(params: Readonly<{
  argv: readonly string[];
  readFileFn?: WorkflowDocumentCommandDeps['readFileFn'];
  readStdinFn?: WorkflowDocumentCommandDeps['readStdinFn'];
  writeFileFn?: WorkflowDocumentCommandDeps['writeFileFn'];
  actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const argv = argvBeforeOptionTerminator(params.argv);
  const operation = argv[0] === 'workflow' && argv[1] === 'definition'
    ? argv[2]
    : null;
  if (operation !== 'import' && operation !== 'export') return false;
  // Structured Action invocations need no local file adaptation.
  if (argv.some((arg) => arg === '--input-json' || arg.startsWith('--input-json='))) return false;

  const deps = { ...DEFAULT_DEPS, ...params };
  const kind = `workflow_definition_${operation}`;
  try {
    const command = commandFor(['workflow', 'definition', operation]);
    const usage = operation === 'import'
      ? 'happier workflow definition import <file|-> [options]'
      : 'happier workflow definition export <definition-id> [file|-] [options]';
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log(renderActionCliHelpModel({ ...buildActionCliHelpModel(command), usage }));
      return true;
    }
    if (operation === 'import') {
      const source = positionalAt(argv, 3);
      if (!source) throw new TypeError('Import requires <file|->.');
      const options = argv.slice(4);
      assertCommandArguments(options, { ...describeCompiledActionCliCommandArgvPolicy(command),
        startIndex: 0, maxPositionals: 0, usage });
      const raw = decodeUtf8(source === '-'
        ? await deps.readStdinFn(params.signal)
        : await deps.readFileFn(resolveAbsolutePathFromWorkingDirectory(source) ?? source));
      params.signal?.throwIfAborted();
      await runCompiledActionCliCommand({
        command,
        argv: [
          ...command.path,
          '--input-json',
          JSON.stringify({ json: raw }),
          ...options,
        ],
        ...(deps.actionExecutionDeps ? { deps: deps.actionExecutionDeps } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return true;
    }

    const definitionId = positionalAt(argv, 3);
    if (!definitionId) throw new TypeError('Export requires <definition-id>.');
    const target = positionalAt(argv, 4);
    const options = argv.slice(target ? 5 : 4);
    assertCommandArguments(options, { ...describeCompiledActionCliCommandArgvPolicy(command),
      startIndex: 0, maxPositionals: 0, usage });
    await runCompiledActionCliCommand({
      command,
      argv: [...command.path, '--input-json', JSON.stringify({ definitionId }), ...options],
      ...(deps.actionExecutionDeps ? { deps: deps.actionExecutionDeps } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      consumeSuccess: async (payload) => {
        const result = WorkflowActionOutputSchemasV1['workflow.definition.export'].parse(payload);
        if (!target || target === '-') {
          await writeJsonStdout(result.document);
        } else {
          await deps.writeFileFn(resolveAbsolutePathFromWorkingDirectory(target) ?? target, `${result.json}\n`);
        }
        return true;
      },
    });
    return true;
  } catch (error) {
    await reportError(
      params.argv,
      kind,
      'invalid_workflow_document_command',
      error instanceof Error ? { message: error.message } : {},
    );
    return true;
  }
}
