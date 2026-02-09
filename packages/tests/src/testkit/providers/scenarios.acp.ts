import type { ProviderScenario } from './types';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fetchAllMessages, fetchSessionV2 } from '../sessions';
import { decryptLegacyBase64 } from '../messageCrypto';
import { cleanupOutsideWorkspacePath, makeOutsideWorkspacePath } from './outsideWorkspacePath';

function k(providerId: string, kind: 'tool-call' | 'tool-result' | 'permission-request', toolName: string): string {
  return `acp/${providerId}/${kind}/${toolName}`;
}

function executeToolCallFixtureKeys(providerId: string): string[] {
  const keys = [k(providerId, 'tool-call', 'Bash'), k(providerId, 'tool-call', 'Terminal'), k(providerId, 'tool-call', 'execute')];
  if (providerId === 'kimi') keys.push(k(providerId, 'tool-call', 'unknown'));
  return keys;
}

function executeToolResultFixtureKeys(providerId: string): string[] {
  const keys = [k(providerId, 'tool-result', 'Bash'), k(providerId, 'tool-result', 'Terminal'), k(providerId, 'tool-result', 'execute')];
  if (providerId === 'kimi') keys.push(k(providerId, 'tool-result', 'unknown'));
  return keys;
}

export function makeAcpReadInWorkspaceScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename?: string;
  content: string;
  useAbsolutePath?: boolean;
}): ProviderScenario {
  const filename = params.filename ?? 'e2e-read.txt';
  const filePathRel = filename;
  return {
    id: params.id ?? 'read_in_workspace',
    title: params.title ?? 'read: read a known small file in workspace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      await (await import('node:fs/promises')).writeFile(join(workspaceDir, filename), `${params.content}\n`, 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call:',
        `- Use the read tool to read: ${params.useAbsolutePath ? join(workspaceDir, filePathRel) : filePathRel}`,
        '- Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredFixtureKeys: [k(params.providerId, 'tool-call', 'Read'), k(params.providerId, 'tool-result', 'Read')],
    requiredTraceSubstrings: [params.content],
  };
}

export function makeAcpReadMissingFileScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename?: string;
}): ProviderScenario {
  const filename = params.filename ?? 'e2e-missing.txt';
  const useKimiFallback = params.providerId === 'kimi';
  return {
    id: params.id ?? 'read_missing_file_in_workspace',
    title: params.title ?? 'read: missing file returns an error (no retries)',
    tier: 'extended',
    yolo: true,
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call:',
        `- Use the read tool to read a file that does NOT exist: ${useKimiFallback ? join(workspaceDir, filename) : filename}`,
        ...(useKimiFallback
          ? [
              '',
              'If Read fails, immediately use execute to run:',
              `  cat "${join(workspaceDir, filename)}"`,
            ]
          : []),
        '',
        'This is an automated test. Do not create the file. Do not retry with other tools if it fails.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    ...(useKimiFallback
      ? {
          requiredAnyFixtureKeys: [
            [
              k(params.providerId, 'tool-call', 'Read'),
              ...executeToolCallFixtureKeys(params.providerId),
            ],
            [
              k(params.providerId, 'tool-result', 'Read'),
              ...executeToolResultFixtureKeys(params.providerId),
            ],
          ],
        }
      : {
          requiredFixtureKeys: [k(params.providerId, 'tool-call', 'Read'), k(params.providerId, 'tool-result', 'Read')],
        }),
    requiredTraceSubstrings: [filename],
    verify: async ({ workspaceDir }) => {
      // Ensure provider did not "helpfully" create the missing file.
      if (existsSync(join(workspaceDir, filename))) {
        throw new Error('Expected missing file to remain absent on disk');
      }
    },
  };
}

export function makeAcpWriteInWorkspaceScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename?: string;
  content: string;
}): ProviderScenario {
  const filename = params.filename ?? 'e2e-write.txt';
  return {
    id: params.id ?? 'write_in_workspace',
    title: params.title ?? 'write: create/update a small file in workspace',
    tier: 'extended',
    yolo: true,
    prompt: ({ workspaceDir }) =>
      [
        'Use exactly one file-editing tool call:',
        `- Use the edit tool to write a file in the current working directory: ${filename}`,
        `- Content: ${params.content}`,
        '',
        'This is an automated test. Do not use execute to write the file.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      [
        k(params.providerId, 'tool-call', 'Patch'),
        k(params.providerId, 'tool-call', 'Edit'),
        k(params.providerId, 'tool-call', 'Write'),
      ],
      [
        k(params.providerId, 'tool-result', 'Patch'),
        k(params.providerId, 'tool-result', 'Edit'),
        k(params.providerId, 'tool-result', 'Write'),
      ],
    ],
    verify: async ({ workspaceDir }) => {
      const filePath = join(workspaceDir, filename);
      const content = await readFile(filePath, 'utf8');
      if (!content.includes(params.content)) {
        throw new Error('Expected file content not present after provider run');
      }
    },
  };
}

/**
 * Experimental scenario to detect whether an ACP provider uses ACP fs methods for writes.
 *
 * This scenario is intentionally *not* part of any provider's default registry; it is meant to be
 * run explicitly via `HAPPIER_E2E_PROVIDER_SCENARIOS=acp_fs_permission_experiment` together with
 * enabling the Happier CLI's ACP fs support (`HAPPIER_ACP_FS=1`).
 *
 * Expected behavior:
 * - If the provider routes file writes through ACP `fs.writeTextFile`, Happier will surface a
 *   permission-request event and can deny the write.
 * - If the provider writes via its own mechanism (no ACP fs), this scenario will likely fail
 *   because no permission-request is emitted and the file is written anyway.
 */
export function makeAcpFsPermissionExperimentScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename?: string;
  content: string;
}): ProviderScenario {
  const filename = params.filename ?? 'e2e-acp-fs-experiment.txt';
  return {
    id: params.id ?? 'acp_fs_permission_experiment',
    title: params.title ?? 'acp fs experiment: deny a workspace write and verify it did not happen',
    tier: 'extended',
    yolo: false,
    permissionAutoDecision: 'denied',
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one file-editing operation (even if it triggers a permission prompt):',
        `- Write a file in the current working directory: ${filename}`,
        `- Content: ${params.content}`,
        '',
        'This is an automated test. Do not use execute to write the file.',
        'If the permission is denied, do not retry with other tools.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    verify: async ({ workspaceDir, traceEvents, baseUrl, token, sessionId, secret }) => {
      const filepath = join(workspaceDir, filename);
      const content = await readFile(filepath, 'utf8').catch(() => '');
      if (content.trim().length > 0) {
        throw new Error('Denied permission but workspace file was written');
      }
    },
  };
}

export function makeAcpMultiFileEditScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  files: Array<{ filename: string; content: string }>;
}): ProviderScenario {
  if (!Array.isArray(params.files) || params.files.length < 2) {
    throw new Error('makeAcpMultiFileEditScenario: expected at least 2 files');
  }

  const steps: NonNullable<ProviderScenario['steps']> = params.files.map((f, i) => {
    const ordinal = i + 1;
    return {
      id: `write_${ordinal}_${f.filename}`,
      prompt: ({ workspaceDir }) =>
        [
          `Use a file-editing tool to write ONE file in the current working directory: ${f.filename}`,
          `- Content: ${f.content}`,
          '',
          'This is an automated test. Do not use execute to write files.',
          'Then reply DONE.',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      satisfaction: {
        requiredAnyFixtureKeys: [
          [k(params.providerId, 'tool-call', 'Patch'), k(params.providerId, 'tool-call', 'Edit'), k(params.providerId, 'tool-call', 'Write')],
          [k(params.providerId, 'tool-result', 'Patch'), k(params.providerId, 'tool-result', 'Edit'), k(params.providerId, 'tool-result', 'Write')],
        ],
        requiredTraceSubstrings: [f.filename],
      },
    };
  });

  return {
    id: params.id ?? 'multi_file_edit_in_workspace',
    title: params.title ?? 'edit: write two small files in workspace (multi-file)',
    tier: 'extended',
    yolo: true,
    // The harness will send prompts from `steps` and enqueue subsequent prompts once each step's satisfaction
    // criteria are met. Keep a top-level prompt for readability in logs, but it is not used for step-based runs.
    prompt: ({ workspaceDir }) => [
      'Use file-editing tools to write exactly TWO files in the current working directory (step-by-step).',
      `Note: current working directory is ${workspaceDir}`,
    ].join('\n'),
    steps,
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'tool-call', 'Patch'), k(params.providerId, 'tool-call', 'Edit'), k(params.providerId, 'tool-call', 'Write')],
      [k(params.providerId, 'tool-result', 'Patch'), k(params.providerId, 'tool-result', 'Edit'), k(params.providerId, 'tool-result', 'Write')],
    ],
    requiredTraceSubstrings: params.files.map((f) => f.filename),
    verify: async ({ workspaceDir, fixtures }) => {
      const { readFile } = await import('node:fs/promises');

      for (const f of params.files) {
        const filePath = join(workspaceDir, f.filename);
        const content = await readFile(filePath, 'utf8').catch(() => '');
        if (!content.includes(f.content)) {
          throw new Error(`Expected file content not present after provider run: ${f.filename}`);
        }
      }

      // Tool-call fixtures should contain both file paths somewhere in the payload inputs.
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') {
        throw new Error('Invalid fixtures: missing examples');
      }

      const callKeys = [
        k(params.providerId, 'tool-call', 'Patch'),
        k(params.providerId, 'tool-call', 'Edit'),
        k(params.providerId, 'tool-call', 'Write'),
      ];
      const resultKeys = [
        k(params.providerId, 'tool-result', 'Patch'),
        k(params.providerId, 'tool-result', 'Edit'),
        k(params.providerId, 'tool-result', 'Write'),
      ];

      const calls = callKeys.flatMap((key) => (Array.isArray((examples as any)[key]) ? (examples as any)[key] : []));
      const results = resultKeys.flatMap((key) => (Array.isArray((examples as any)[key]) ? (examples as any)[key] : []));

      for (const f of params.files) {
        const hasPath = calls.some((e: any) => {
          const input = e?.payload?.input;
          const single =
            input?.filepath ??
            input?.filePath ??
            input?.file_path ??
            input?.filePathRel ??
            (Array.isArray(input?.locations) && input.locations.length > 0 ? input.locations[0]?.path : undefined);

          if (typeof single === 'string' && single.endsWith(`/${f.filename}`)) return true;

          const many = Array.isArray(input?.file_paths) ? input.file_paths : Array.isArray(input?.filePaths) ? input.filePaths : null;
          if (many && many.some((p: any) => typeof p === 'string' && p.endsWith(`/${f.filename}`))) return true;

          const patchLike = input?.changes ?? input?.unified_diff ?? null;
          if (patchLike) {
            const raw = typeof patchLike === 'string' ? patchLike : JSON.stringify(patchLike);
            if (typeof raw === 'string' && raw.includes(f.filename)) return true;
          }

          return false;
        });
        const hasResultPath = results.some((e: any) => {
          const output = e?.payload?.output;
          if (!output || typeof output !== 'object') return false;

          const metadata = output.metadata && typeof output.metadata === 'object' ? output.metadata : null;
          const candidatePaths = [
            metadata?.filepath,
            metadata?.filePath,
            metadata?.file_path,
            output.filepath,
            output.filePath,
            output.file_path,
            output?._acp?.title,
          ];
          return candidatePaths.some((p) => typeof p === 'string' && p.endsWith(`/${f.filename}`));
        });

        if (!hasPath && !hasResultPath) {
          throw new Error(`Expected at least one tool fixture to reference ${f.filename}`);
        }
      }
    },
  };
}

export function makeAcpSearchKnownTokenScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename?: string;
  token: string;
}): ProviderScenario {
  const filename = params.filename ?? 'e2e-search.txt';
  return {
    id: params.id ?? 'search_known_token',
    title: params.title ?? 'search: find a known token in workspace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      await (await import('node:fs/promises')).writeFile(
        join(workspaceDir, filename),
        `alpha\nbeta\n${params.token}\n`,
        'utf8',
      );
    },
    prompt: ({ workspaceDir }) =>
      [
        'Search for the exact token in the current working directory.',
        '',
        'Preferred: use the search tool.',
        'Fallback (if the provider does not expose a search tool): use execute to run a command like:',
        `  rg -n -F "${params.token}" .`,
        '',
        params.token,
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      [
        k(params.providerId, 'tool-call', 'CodeSearch'),
        k(params.providerId, 'tool-call', 'Search'),
        k(params.providerId, 'tool-call', 'Grep'),
        k(params.providerId, 'tool-call', 'Bash'),
      ],
      [
        k(params.providerId, 'tool-result', 'CodeSearch'),
        k(params.providerId, 'tool-result', 'Search'),
        k(params.providerId, 'tool-result', 'Grep'),
        k(params.providerId, 'tool-result', 'Bash'),
      ],
    ],
    requiredTraceSubstrings: [params.token],
  };
}

export function makeAcpPermissionDenyReadScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename?: string;
  token: string;
}): ProviderScenario {
  const filename = params.filename ?? 'e2e-deny-read.txt';
  return {
    id: params.id ?? 'permission_deny_read',
    title: params.title ?? 'permission: deny a read tool call',
    tier: 'extended',
    yolo: false,
    permissionAutoDecision: 'denied',
    setup: async ({ workspaceDir }) => {
      await (await import('node:fs/promises')).writeFile(join(workspaceDir, filename), `DENY\n${params.token}\n`, 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Use exactly one tool call:',
        `- Use the read tool to read: ${filename}`,
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'permission-request', 'Read')],
      [k(params.providerId, 'tool-result', 'Read')],
    ],
    requiredTraceSubstrings: [filename],
    verify: async ({ traceEvents }) => {
      // The file content should not be present in tool-trace payloads when permission is denied.
      const raw = JSON.stringify(traceEvents.map((e) => e?.payload ?? null));
      if (raw.includes(params.token)) {
        throw new Error('Expected denied read to omit file contents from tool trace');
      }
    },
  };
}

export function makeAcpPermissionDenyOutsideWorkspaceReadScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  token: string;
}): ProviderScenario {
  let outsidePath: string | null = null;
  return {
    id: params.id ?? 'permission_deny_read_outside_workspace',
    title: params.title ?? 'permission: deny a read tool call outside workspace',
    tier: 'extended',
    yolo: false,
    permissionAutoDecision: 'denied',
    setup: async ({ workspaceDir }) => {
      outsidePath = makeOutsideWorkspacePath({
        workspaceDir,
        prefix: 'happier-e2e-deny-read-outside',
      });
      await (await import('node:fs/promises')).writeFile(outsidePath, `DENY_OUTSIDE\n${params.token}\n`, 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call (even if it triggers a permission prompt):',
        'Use the read tool to read a file OUTSIDE the current working directory:',
        `- Absolute path: ${(() => {
          if (!outsidePath) {
            // Fallback for direct builder-unit tests that call prompt without setup.
            outsidePath = makeOutsideWorkspacePath({
              workspaceDir,
              prefix: 'happier-e2e-deny-read-outside',
            });
          }
          return outsidePath;
        })()}`,
        '',
        'If the permission is denied, do not retry with other tools.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'permission-request', 'Read'), k(params.providerId, 'permission-request', 'read')],
      [k(params.providerId, 'tool-result', 'Read')],
    ],
    verify: async ({ traceEvents }) => {
      try {
        // The file content should not be present in tool-trace payloads when permission is denied.
        const raw = JSON.stringify(traceEvents.map((e) => e?.payload ?? null));
        if (raw.includes(params.token)) {
          throw new Error('Expected denied outside-workspace read to omit file contents from tool trace');
        }
      } finally {
        await cleanupOutsideWorkspacePath(outsidePath);
        outsidePath = null;
      }
    },
  };
}

export function makeAcpMultiFileEditIncludesDiffScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  files: Array<{ filename: string; before: string; after: string }>;
}): ProviderScenario {
  if (!Array.isArray(params.files) || params.files.length < 2) {
    throw new Error('makeAcpMultiFileEditIncludesDiffScenario: expected at least 2 files');
  }

  const files = params.files;
  const steps: NonNullable<ProviderScenario['steps']> = files.map((f, i) => {
    const ordinal = i + 1;
    return {
      id: `edit_${ordinal}_${f.filename}`,
      prompt: ({ workspaceDir }) =>
        [
          `Use a file-editing tool (Edit or Patch; not Write, not execute) to update ONE file: ${f.filename}`,
          `- Replace the content "${f.before}" with "${f.after}"`,
          '',
          'This is an automated test. Do not use execute to edit files.',
          'Then reply DONE.',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      satisfaction: {
        requiredAnyFixtureKeys: [
          [k(params.providerId, 'tool-call', 'Patch'), k(params.providerId, 'tool-call', 'Edit')],
          [k(params.providerId, 'tool-result', 'Patch'), k(params.providerId, 'tool-result', 'Edit')],
        ],
        requiredTraceSubstrings: [f.filename, f.after],
      },
    };
  });

  return {
    id: params.id ?? 'multi_file_edit_in_workspace_includes_diff',
    title: params.title ?? 'edit/patch: multi-file edit includes diff-like evidence in trace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      const { writeFile } = await import('node:fs/promises');
      for (const f of files) {
        await writeFile(join(workspaceDir, f.filename), `${f.before}\n`, 'utf8');
      }
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run multiple file-editing tool calls step-by-step:',
        '- For each file, use Edit or Patch (not Write, not execute) to replace the sentinel text.',
        'Then reply DONE after each step.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    steps,
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'tool-call', 'Patch'), k(params.providerId, 'tool-call', 'Edit')],
      [k(params.providerId, 'tool-result', 'Patch'), k(params.providerId, 'tool-result', 'Edit')],
    ],
    requiredTraceSubstrings: files.flatMap((f) => [f.filename, f.after]),
    verify: async ({ workspaceDir, traceEvents, baseUrl, token, sessionId, secret }) => {
      // Ensure all files were updated.
      for (const f of files) {
        const content = await readFile(join(workspaceDir, f.filename), 'utf8').catch(() => '');
        if (!content.includes(f.after)) {
          throw new Error(`Expected file content to be updated for ${f.filename}`);
        }
      }

      // Ensure we captured at least one diff-like trace signal:
      // - Edit tool-result metadata.diff
      // - Patch tool-call input.changes
      const payloads = (traceEvents ?? []).map((e: any) => e?.payload).filter(Boolean);
      const hasDiffResult = payloads.some((p: any) => {
        if (p?.type !== 'tool-result') return false;
        const diff = p?.output?.metadata?.diff;
        return typeof diff === 'string' && diff.trim().length > 0;
      });
      const hasPatchChanges = payloads.some((p: any) => {
        if (p?.type !== 'tool-call') return false;
        if (p?.name !== 'Patch') return false;
        const changes = p?.input?.changes;
        return changes && typeof changes === 'object' && Object.keys(changes).length > 0;
      });

      if (!hasDiffResult && !hasPatchChanges) {
        throw new Error('Expected either tool-result output.metadata.diff or Patch tool-call input.changes');
      }
    },
  };
}

export function makeAcpGlobListFilesScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filenames: string[];
  command?: string;
}): ProviderScenario {
  const filenames = params.filenames;
  if (!Array.isArray(filenames) || filenames.length < 2) {
    throw new Error('makeAcpGlobListFilesScenario: expected at least 2 filenames');
  }
  const cmd = params.command ?? 'ls -1 e2e-*.txt';
  return {
    id: params.id ?? 'glob_list_files',
    title: params.title ?? 'glob/ls: list files in workspace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      const { writeFile } = await import('node:fs/promises');
      for (const f of filenames) {
        await writeFile(join(workspaceDir, f), `${f}\n`, 'utf8');
      }
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call:',
        `- Use the execute tool to run: ${cmd}`,
        '- Do not use any other tool (especially do not use search).',
        'Then reply DONE.',
        '',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'tool-call', 'Bash'), k(params.providerId, 'tool-call', 'CodeSearch')],
      [k(params.providerId, 'tool-result', 'Bash'), k(params.providerId, 'tool-result', 'CodeSearch')],
    ],
    requiredTraceSubstrings: [...filenames],
  };
}

export function makeAcpSearchLsEquivalenceScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filenames: string[];
  token: string;
  lsCommand?: string;
}): ProviderScenario {
  const filenames = params.filenames;
  if (!Array.isArray(filenames) || filenames.length < 2) {
    throw new Error('makeAcpSearchLsEquivalenceScenario: expected at least 2 filenames');
  }
  const lsCommand = params.lsCommand ?? 'ls -1 e2e-*.txt';

  const tokenFile = filenames[0] ?? 'e2e-search-ls.txt';

  const steps: NonNullable<ProviderScenario['steps']> = [
    {
      id: 'ls',
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          `- Use the execute tool to run: ${lsCommand}`,
          '- Do not use any other tool (especially do not use search).',
          'Then reply DONE.',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      satisfaction: {
        requiredAnyFixtureKeys: [
          [k(params.providerId, 'tool-call', 'Bash'), k(params.providerId, 'tool-call', 'CodeSearch')],
          [k(params.providerId, 'tool-result', 'Bash'), k(params.providerId, 'tool-result', 'CodeSearch')],
        ],
        requiredTraceSubstrings: [...filenames],
      },
    },
    {
      id: 'search',
      prompt: ({ workspaceDir }) =>
        [
          'Search for the exact token in the current working directory.',
          '',
          'Preferred: use the search tool.',
          'Fallback (if the provider does not expose a search tool): use execute to run a command like:',
          `  rg -n -F "${params.token}" .`,
          '',
          params.token,
          'Then reply DONE.',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      satisfaction: {
        requiredAnyFixtureKeys: [
          [
            k(params.providerId, 'tool-call', 'CodeSearch'),
            k(params.providerId, 'tool-call', 'Search'),
            k(params.providerId, 'tool-call', 'Grep'),
            k(params.providerId, 'tool-call', 'Bash'),
          ],
          [
            k(params.providerId, 'tool-result', 'CodeSearch'),
            k(params.providerId, 'tool-result', 'Search'),
            k(params.providerId, 'tool-result', 'Grep'),
            k(params.providerId, 'tool-result', 'Bash'),
          ],
        ],
        requiredTraceSubstrings: [params.token],
      },
    },
  ];

  return {
    id: params.id ?? 'search_ls_equivalence',
    title: params.title ?? 'search+ls: file found by search appears in ls output',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      const { writeFile } = await import('node:fs/promises');
      for (const f of filenames) {
        const content = f === tokenFile ? `alpha\n${params.token}\nomega\n` : `${f}\n`;
        await writeFile(join(workspaceDir, f), content, 'utf8');
      }
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run two tool calls step-by-step:',
        '- First: execute ls to list matching files',
        '- Second: search for a known token',
        'Then reply DONE after each step.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    steps,
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'tool-call', 'Bash'), k(params.providerId, 'tool-call', 'CodeSearch')],
      [k(params.providerId, 'tool-result', 'Bash'), k(params.providerId, 'tool-result', 'CodeSearch')],
      [
        k(params.providerId, 'tool-call', 'CodeSearch'),
        k(params.providerId, 'tool-call', 'Search'),
        k(params.providerId, 'tool-call', 'Grep'),
        k(params.providerId, 'tool-call', 'Bash'),
      ],
      [
        k(params.providerId, 'tool-result', 'CodeSearch'),
        k(params.providerId, 'tool-result', 'Search'),
        k(params.providerId, 'tool-result', 'Grep'),
        k(params.providerId, 'tool-result', 'Bash'),
      ],
    ],
    requiredTraceSubstrings: [...filenames, params.token],
    verify: async ({ traceEvents }) => {
      // Non-brittle equivalence: ensure the file path mentioned by search appears in the ls output.
      const lsOutputs = traceEvents
        .map((e: any) => e?.payload)
        .filter((p: any) => {
          if (p?.type !== 'tool-result') return false;
          const tool = p?.output?._happier?.canonicalToolName;
          return tool === 'Bash' || tool === 'CodeSearch';
        })
        .map((p: any) => {
          const out = p?.output ?? null;
          if (!out || typeof out !== 'object') return '';
          if (typeof (out as any).output === 'string') return String((out as any).output);
          if (typeof (out as any).stdout === 'string') return String((out as any).stdout);
          if (typeof (out as any).formatted_output === 'string') return String((out as any).formatted_output);
          if (typeof (out as any).aggregated_output === 'string') return String((out as any).aggregated_output);
          return '';
        });

      const lsText = lsOutputs.join('\n').trim();
      const raw = lsText.length > 0 ? lsText : JSON.stringify(traceEvents.map((e: any) => e?.payload ?? null));
      if (!raw.includes(tokenFile)) {
        throw new Error('Expected ls output (or trace payloads) to reference the token file');
      }
    },
  };
}

export function makeAcpPatchIncludesDiffScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename: string;
  before: string;
  after: string;
}): ProviderScenario {
  const filename = params.filename;
  return {
    id: params.id ?? 'patch_includes_diff',
    title: params.title ?? 'patch: Patch tool-call includes diff-like changes',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(workspaceDir, filename), `${params.before}\n`, 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call:',
        `- Use the Patch tool (not Edit, not Write, not execute) to update the file: ${filename}`,
        `- Replace the content "${params.before}" with "${params.after}"`,
        '',
        'This is an automated test. Do not use execute to edit files.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'tool-call', 'Patch')],
      [k(params.providerId, 'tool-result', 'Patch')],
    ],
    requiredTraceSubstrings: [filename, params.after],
    verify: async ({ workspaceDir, traceEvents, baseUrl, token, sessionId, secret }) => {
      const calls = traceEvents.filter((e: any) => e?.payload?.name === 'Patch' && e?.payload?.type === 'tool-call');
      if (!calls.length) {
        throw new Error('Expected at least one Patch tool-call in traceEvents');
      }
      const hasChanges = calls.some((e: any) => {
        const input = e?.payload?.input;
        if (!input || typeof input !== 'object') return false;
        const changes = (input as any).changes;
        return changes && typeof changes === 'object' && Object.keys(changes).length > 0;
      });
      if (!hasChanges) {
        throw new Error('Expected Patch tool-call input.changes to be a non-empty object');
      }

      const content = await readFile(join(workspaceDir, filename), 'utf8').catch(() => '');
      if (!content.includes(params.after)) {
        throw new Error('Expected file content to be updated by Patch tool call');
      }
    },
  };
}

export function makeAcpEditResultIncludesDiffScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename: string;
  before: string;
  after: string;
}): ProviderScenario {
  const filename = params.filename;
  return {
    id: params.id ?? 'edit_result_includes_diff',
    title: params.title ?? 'edit/patch: file edit includes diff-like metadata',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(workspaceDir, filename), `${params.before}\n`, 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly two tool calls:',
        `- First, use the Read tool to read the file: ${filename}`,
        `- Second, use a file-editing tool (Edit or Patch; not Write, not execute) to update the file: ${filename}`,
        `- Replace the content "${params.before}" with "${params.after}"`,
        '',
        'This is an automated test. Do not use execute to edit files.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      [k(params.providerId, 'tool-call', 'Read')],
      [k(params.providerId, 'tool-result', 'Read')],
      [k(params.providerId, 'tool-call', 'Edit'), k(params.providerId, 'tool-call', 'Patch')],
      [k(params.providerId, 'tool-result', 'Edit'), k(params.providerId, 'tool-result', 'Patch')],
    ],
    requiredTraceSubstrings: [filename, params.after],
    verify: async ({ workspaceDir, traceEvents, baseUrl, token, sessionId, secret }) => {
      const results = traceEvents
        .map((e: any) => e?.payload)
        .filter((p: any) => p?.type === 'tool-result' && (p?.output?._happier?.canonicalToolName === 'Edit' || p?.output?._acp?.kind === 'edit'));
      const hasDiff = results.some((e: any) => {
        const diff = e?.output?.metadata?.diff;
        return typeof diff === 'string' && diff.length > 0;
      });
      const patchCalls = traceEvents
        .map((e: any) => e?.payload)
        .filter((p: any) => p?.type === 'tool-call' && p?.name === 'Patch');
      const hasChanges = patchCalls.some((e: any) => {
        const changes = e?.input?.changes;
        return changes && typeof changes === 'object' && Object.keys(changes).length > 0;
      });

      if (!hasDiff && !hasChanges) {
        throw new Error('Expected either Edit tool-result output.metadata.diff or Patch tool-call input.changes');
      }

      const content = await readFile(join(workspaceDir, filename), 'utf8').catch(() => '');
      if (!content.includes(params.after)) {
        throw new Error('Expected file content to be updated by file-editing tool call');
      }
    },
  };
}

export function makeAcpPermissionOutsideWorkspaceScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  content: string;
  decision?: 'approve' | 'deny';
  /**
   * Some ACP providers auto-apply edits without surfacing ACP permission requests.
   * When false, this scenario only asserts the tool call/result and filesystem side effects.
   */
  expectPermissionRequest?: boolean;
  /**
   * Whether approved writes must fully complete (tool-result + filesystem write).
   *
   * When false, the scenario only requires prompt/attempt evidence and treats
   * file write verification as best-effort.
   */
  expectWriteCompletion?: boolean;
  /**
   * When false, restrictive modes that emit no tool attempts are allowed to
   * complete without a `task_complete` trace event.
   */
  requireTaskCompleteWhenNoToolAttempt?: boolean;
}): ProviderScenario {
  const decision = params.decision ?? 'approve';
  const expectPermissionRequest = params.expectPermissionRequest ?? true;
  // Avoid OS temp directories: some providers (notably Codex) treat $TMPDIR and /tmp as writable roots
  // under sandbox_mode="workspace-write", which would make "outside workspace" edits silently succeed
  // without emitting permission requests. Instead, target the parent dir of the workspace to ensure
  // the path is outside the current working directory but still exists on disk.
  let outsidePath: string | null = null;
  const permissionDecision = decision === 'deny' ? 'denied' : 'approved';
  const expectsWritten = decision === 'approve';
  const expectWriteCompletion = params.expectWriteCompletion ?? expectsWritten;
  const requireTaskCompleteWhenNoToolAttempt = params.requireTaskCompleteWhenNoToolAttempt ?? true;
  const requireToolAttempt = expectWriteCompletion || expectPermissionRequest;
  const allowExecuteFallback = expectWriteCompletion && !expectPermissionRequest;

  return {
    id: params.id ?? (decision === 'deny' ? 'permission_deny_outside_workspace' : 'permission_surface_outside_workspace'),
    title:
      params.title ??
      (decision === 'deny'
        ? 'permissions: deny an outside-workspace write and verify it did not happen'
        : 'permissions: editing outside workspace surfaces a permission-request trace'),
    tier: 'extended',
    yolo: false,
    // For ACP providers, permission prompts are provider-configurable via their own CLI/env settings
    // (e.g. Codex sandbox_mode/approval_policy, OpenCode/Kilo OPENCODE_PERMISSION). Provider harness
    // runs attach to an existing session and does not override permissionMode by default; force a
    // prompting mode for scenarios that expect permission requests so the provider is configured to ask.
    ...(expectPermissionRequest ? { messageMeta: { permissionMode: 'safe-yolo' } } : null),
    permissionAutoDecision: permissionDecision as any,
    setup: async ({ workspaceDir }) => {
      outsidePath = makeOutsideWorkspacePath({
        workspaceDir,
        prefix: `happier-e2e-outside-${decision}`,
      });
      await cleanupOutsideWorkspacePath(outsidePath);
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call (even if it triggers a permission prompt):',
        'Use the edit tool to write a file OUTSIDE the current working directory:',
        `- Absolute path: ${(() => {
          if (!outsidePath) {
            // Fallback for direct builder-unit tests that call prompt without setup.
            outsidePath = makeOutsideWorkspacePath({
              workspaceDir,
              prefix: `happier-e2e-outside-${decision}`,
            });
          }
          return outsidePath;
        })()}`,
        `- Content: ${params.content}`,
        '',
        allowExecuteFallback
          ? 'This is an automated test. Prefer edit/write tools; execute is allowed as a fallback.'
          : 'This is an automated test. Do not use execute to write the file.',
        decision === 'deny' ? 'If the permission is denied, do not retry with other tools.' : null,
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ]
        .filter(Boolean)
        .join('\n'),
    // Some providers enforce permissions by refusing to even emit a tool call (e.g. "read-only" modes).
    // In those cases, wait for the turn to complete so the scenario doesn't time out due to missing tool traces.
    ...(requireToolAttempt || !requireTaskCompleteWhenNoToolAttempt ? null : { requiredTraceSubstrings: ['task_complete'] }),
    requiredAnyFixtureKeys: [
      ...(expectPermissionRequest
        ? ([
            [
              k(params.providerId, 'permission-request', 'Edit'),
              k(params.providerId, 'permission-request', 'Write'),
              k(params.providerId, 'permission-request', 'edit'),
              k(params.providerId, 'permission-request', 'write'),
            ],
          ] as string[][])
        : []),
      ...(requireToolAttempt
        ? ([
            // When a permission request is denied, many ACP agents will not emit a tool-result.
            // Still require evidence that the agent attempted an edit when interactive permissions are expected.
            [
              k(params.providerId, 'tool-call', 'Patch'),
              k(params.providerId, 'tool-call', 'Edit'),
              k(params.providerId, 'tool-call', 'Write'),
              ...(allowExecuteFallback
                ? [k(params.providerId, 'tool-call', 'Bash'), k(params.providerId, 'tool-call', 'Terminal'), k(params.providerId, 'tool-call', 'execute')]
                : []),
            ],
          ] as string[][])
        : []),
      ...(expectsWritten
        ? expectWriteCompletion
          ? ([
              [
                k(params.providerId, 'tool-result', 'Patch'),
                k(params.providerId, 'tool-result', 'Edit'),
                k(params.providerId, 'tool-result', 'Write'),
                ...(allowExecuteFallback
                  ? [k(params.providerId, 'tool-result', 'Bash'), k(params.providerId, 'tool-result', 'Terminal'), k(params.providerId, 'tool-result', 'execute')]
                  : []),
              ],
            ] as string[][])
          : []
        : []),
    ],
    verify: async ({ fixtures }) => {
      let filepath = outsidePath;
      try {
        filepath = expectPermissionRequest
          ? (() => {
              const keys = [
                k(params.providerId, 'permission-request', 'Edit'),
                k(params.providerId, 'permission-request', 'Write'),
                k(params.providerId, 'permission-request', 'edit'),
                k(params.providerId, 'permission-request', 'write'),
                k(params.providerId, 'permission-request', 'unknown'),
              ];
              const key = keys.find((kk) => {
                  const v = fixtures?.examples?.[kk];
                  return Array.isArray(v) && v.length > 0;
                }) ?? null;
              if (!key) throw new Error('Missing permission-request fixtures (Edit/Write)');

              const reqs = (fixtures?.examples?.[key] ?? []) as any[];
              if (!Array.isArray(reqs) || reqs.length === 0) throw new Error('Missing permission-request fixtures');
              const requestedPath =
                reqs[0]?.payload?.options?.input?.filepath ??
                reqs[0]?.payload?.options?.input?.filePath ??
                reqs[0]?.payload?.options?.input?.path ??
                reqs[0]?.payload?.options?.toolCall?.content?.find((entry: any) => typeof entry?.path === 'string')?.path ??
                reqs[0]?.payload?.options?.input?.content?.find((entry: any) => typeof entry?.path === 'string')?.path;
              if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
                throw new Error('permission-request missing options.input.filepath');
              }
              return requestedPath;
            })()
          : (() => {
              if (!outsidePath) throw new Error('Internal error: outsidePath not initialized');
              return outsidePath;
            })();

        if (expectsWritten) {
          if (expectWriteCompletion) {
            const content = await readFile(filepath, 'utf8').catch(() => '');
            if (!content.includes(params.content)) {
              throw new Error(`Approved permission but expected content was not written: ${filepath}`);
            }
          } else if (existsSync(filepath)) {
            const content = await readFile(filepath, 'utf8').catch(() => '');
            if (content.length > 0 && !content.includes(params.content)) {
              throw new Error(`Unexpected outside-workspace write content mismatch: ${filepath}`);
            }
          }
        } else if (existsSync(filepath)) {
          throw new Error(`Denied permission but file exists on disk: ${filepath}`);
        }
      } finally {
        await cleanupOutsideWorkspacePath(filepath);
        outsidePath = null;
      }
    },
  };
}

export function makeAcpPermissionExecuteWritesWorkspaceFileScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename: string;
  content: string;
  decision: 'approve' | 'deny';
}): ProviderScenario {
  const permissionDecision = params.decision === 'deny' ? 'denied' : 'approved';
  const expectsWritten = params.decision === 'approve';
  const resultKeys = executeToolResultFixtureKeys(params.providerId);
  const callKeys = executeToolCallFixtureKeys(params.providerId);

  return {
    id: params.id ?? (expectsWritten ? 'permission_surface_execute' : 'permission_deny_execute'),
    title:
      params.title ??
      (expectsWritten
        ? 'permissions: execute surfaces a permission-request trace (approve)'
        : 'permissions: deny execute and verify it did not run'),
    tier: 'extended',
    yolo: false,
    permissionAutoDecision: permissionDecision as any,
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call (even if it triggers a permission prompt):',
        `- Use the execute tool to run: sh -lc "echo ${params.content} > ${params.filename} && cat ${params.filename}"`,
        '- Then reply DONE.',
        '',
        'This is an automated test. Do not use Patch/Edit/Write for this scenario.',
        params.decision === 'deny' ? 'If the permission is denied, do not retry with other tools.' : null,
        `Note: current working directory is ${workspaceDir}`,
      ]
        .filter(Boolean)
        .join('\n'),
    requiredTraceSubstrings: ['permission-request', params.filename],
    requiredAnyFixtureKeys: expectsWritten
      ? [
          callKeys,
          resultKeys,
        ]
      : undefined,
    verify: async ({ workspaceDir, traceEvents, baseUrl, token, sessionId, secret }) => {
      const payloads = (traceEvents ?? []).map((e: any) => e?.payload).filter(Boolean);
      const hasPermission = payloads.some((p: any) => p?.type === 'permission-request');
      if (!hasPermission) {
        // Some providers can surface permission prompts in agentState even when a tool-trace
        // permission-request event is missing/dropped. Prefer trace evidence, but fall back
        // to agentState so we still validate that the permission gate existed.
        //
        // Note: verify() has access to baseUrl/token/sessionId/secret, so this stays a real
        // end-to-end check (no mocks).
        const snap = await fetchSessionV2(baseUrl, token, sessionId);
        const state = snap.agentState ? (decryptLegacyBase64(snap.agentState, secret) as any) : null;
        const requests = state && typeof state === 'object' ? (state as any).requests : null;
        const completedRequests = state && typeof state === 'object' ? (state as any).completedRequests : null;
        const hasExecutePermission =
          (requests &&
            typeof requests === 'object' &&
            Object.values(requests as any).some((r: any) => (r?.tool ?? r?.toolName) === 'execute')) ||
          (completedRequests &&
            typeof completedRequests === 'object' &&
            Object.values(completedRequests as any).some((r: any) => (r?.tool ?? r?.toolName) === 'execute'));
        if (!hasExecutePermission) {
          throw new Error('Expected at least one permission-request event in tool trace (or execute permission in agentState)');
        }
      }

      const filepath = join(workspaceDir, params.filename);
      const content = await readFile(filepath, 'utf8').catch(() => '');

      if (expectsWritten) {
        if (!content.includes(params.content)) {
          throw new Error('Approved permission but expected file content was not written in workspace');
        }
      } else {
        if (content.trim().length > 0) {
          throw new Error('Denied permission but workspace file was written');
        }
      }
    },
  };
}

export function makeAcpPermissionPatchApplyScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  filename: string;
  before: string;
  after: string;
  decision: 'approve' | 'deny';
  /**
   * Some ACP providers do not surface patch permission prompts.
   * When false, this scenario validates side effects without requiring permission-request evidence.
   */
  expectPermissionRequest?: boolean;
}): ProviderScenario {
  const permissionDecision = params.decision === 'deny' ? 'denied' : 'approved';
  const expectsWritten = params.decision === 'approve';
  const expectPermissionRequest = params.expectPermissionRequest ?? true;
  const resultKeys = [k(params.providerId, 'tool-result', 'Edit'), k(params.providerId, 'tool-result', 'Patch'), k(params.providerId, 'tool-result', 'Write')];
  const callKeys = [k(params.providerId, 'tool-call', 'Edit'), k(params.providerId, 'tool-call', 'Patch'), k(params.providerId, 'tool-call', 'Write')];

  return {
    id: params.id ?? (expectsWritten ? 'permission_surface_patch_apply' : 'permission_deny_patch_apply'),
    title:
      params.title ??
      (expectsWritten
        ? 'permissions: applying a patch surfaces a permission-request trace (approve)'
        : 'permissions: deny patch apply and verify it did not happen'),
    tier: 'extended',
    yolo: false,
    permissionAutoDecision: permissionDecision as any,
    setup: async ({ workspaceDir }) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(workspaceDir, params.filename), `${params.before}\n`, 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call (even if it triggers a permission prompt):',
        `- Update the file ${params.filename} by replacing the text "${params.before}" with "${params.after}"`,
        '',
        'This is an automated test.',
        '- Do not use execute to edit files.',
        '- Do not create new files.',
        params.decision === 'deny' ? 'If the permission is denied, do not retry with other tools.' : null,
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ...(
      expectPermissionRequest
        ? { requiredTraceSubstrings: ['permission-request', params.filename] }
        : expectsWritten
          ? { requiredTraceSubstrings: [params.filename] }
          : {}
    ),
    requiredAnyFixtureKeys: expectsWritten
      ? [
          callKeys,
          resultKeys,
        ]
      : undefined,
    verify: async ({ workspaceDir, traceEvents, baseUrl, token, sessionId, secret }) => {
      if (expectPermissionRequest) {
        const payloads = (traceEvents ?? []).map((e: any) => e?.payload).filter(Boolean);
        const hasPermission = payloads.some((p: any) => p?.type === 'permission-request');
        if (!hasPermission) {
          const snap = await fetchSessionV2(baseUrl, token, sessionId);
          const state = snap.agentState ? (decryptLegacyBase64(snap.agentState, secret) as any) : null;
          const requests = state && typeof state === 'object' ? (state as any).requests : null;
          const completedRequests = state && typeof state === 'object' ? (state as any).completedRequests : null;
          const isFileEditToolName = (value: unknown) => {
            const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
            return normalized === 'edit' || normalized === 'patch' || normalized === 'write';
          };
          const hasFileEditPermission =
            (requests &&
              typeof requests === 'object' &&
              Object.values(requests as any).some((r: any) => isFileEditToolName(r?.tool ?? r?.toolName))) ||
            (completedRequests &&
              typeof completedRequests === 'object' &&
              Object.values(completedRequests as any).some((r: any) => isFileEditToolName(r?.tool ?? r?.toolName)));
          if (!hasFileEditPermission) {
            throw new Error('Expected at least one permission-request event in tool trace (or permission evidence in agentState)');
          }
        }
      }

      const filepath = join(workspaceDir, params.filename);
      const content = await readFile(filepath, 'utf8').catch(() => '');

      if (expectsWritten) {
        if (!content.includes(params.after)) {
          throw new Error('Approved permission but expected file content was not updated');
        }
      } else {
        if (content.includes(params.after)) {
          throw new Error('Denied permission but file content was updated');
        }
        if (!content.includes(params.before)) {
          throw new Error('Denied permission but expected file to remain unchanged');
        }
      }
    },
  };
}

export function makeAcpResumeLoadSessionScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  metadataKey: string;
  phase1TraceSentinel: string;
  phase2TraceSentinel: string;
}): ProviderScenario {
  return {
    id: params.id ?? 'acp_resume_load_session',
    title: params.title ?? 'resume: second attach uses --resume from session metadata',
    tier: 'extended',
    yolo: true,
    allowPermissionAutoApproveInYolo: true,
    assertPendingDrain: false,
    prompt: ({ workspaceDir }) =>
      [
        `Use the execute tool to run: echo ${params.phase1TraceSentinel}`,
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    resume: {
      metadataKey: params.metadataKey,
      prompt: ({ workspaceDir }) =>
        [
          `Use the execute tool to run: echo ${params.phase2TraceSentinel}`,
          'Then reply DONE.',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredTraceSubstrings: [params.phase2TraceSentinel],
    },
    requiredAnyFixtureKeys: [executeToolCallFixtureKeys(params.providerId), executeToolResultFixtureKeys(params.providerId)],
    requiredTraceSubstrings: [params.phase1TraceSentinel],
    verify: async ({ baseUrl, token, sessionId, secret, resumeId }) => {
      if (!resumeId) throw new Error('Expected resumeId to be available for resume scenario');
      const snap = await fetchSessionV2(baseUrl, token, sessionId);
      const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
      const value = metadata && typeof metadata === 'object' ? (metadata as any)[params.metadataKey] : null;
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Expected ${params.metadataKey} to be present in session metadata after resume`);
      }
      if (value.trim() !== resumeId) {
        throw new Error(`Expected ${params.metadataKey} to remain stable after resume (loadSession should not create a new session)`);
      }
    },
  };
}

export function makeAcpResumeFreshSessionImportsHistoryScenario(params: {
  providerId: string;
  id?: string;
  title?: string;
  metadataKey: string;
  phase1TraceSentinel: string;
  phase1TextSentinel: string;
  phase2TraceSentinel: string;
  phase2TextSentinel: string;
}): ProviderScenario {
  return {
    id: params.id ?? 'acp_resume_fresh_session_imports_history',
    title: params.title ?? 'resume: fresh session imports remote transcript history',
    tier: 'extended',
    yolo: true,
    allowPermissionAutoApproveInYolo: true,
    assertPendingDrain: false,
    prompt: ({ workspaceDir }) =>
      [
        `Use the execute tool to run: echo ${params.phase1TraceSentinel}`,
        `Then reply with EXACTLY: ${params.phase1TextSentinel}`,
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    resume: {
      metadataKey: params.metadataKey,
      freshSession: true,
      prompt: ({ workspaceDir }) =>
        [
          `Use the execute tool to run: echo ${params.phase2TraceSentinel}`,
          `Then reply with EXACTLY: ${params.phase2TextSentinel}`,
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredTraceSubstrings: [params.phase2TraceSentinel],
    },
    requiredAnyFixtureKeys: [executeToolCallFixtureKeys(params.providerId), executeToolResultFixtureKeys(params.providerId)],
    requiredTraceSubstrings: [params.phase1TraceSentinel],
    verify: async ({ baseUrl, token, sessionId, resumeSessionId, secret }) => {
      if (!resumeSessionId || resumeSessionId === sessionId) {
        throw new Error('Expected resumeSessionId to be a new session id for fresh-session resume');
      }

      const messages = await fetchAllMessages(baseUrl, token, resumeSessionId);
      const decoded = messages.map((m) => decryptLegacyBase64(m.content.c, secret) as any);
      const imported = decoded.filter((m) => m && typeof m === 'object' && (m as any).meta?.importedFrom === 'acp-history');
      if (imported.length === 0) throw new Error('Expected at least one imported message (meta.importedFrom="acp-history")');
      const hasPhase1Text = imported.some(
        (m) => typeof m?.content?.text === 'string' && m.content.text.includes(params.phase1TextSentinel),
      );
      if (!hasPhase1Text) throw new Error('Expected imported history to include phase 1 assistant sentinel text');
    },
  };
}
