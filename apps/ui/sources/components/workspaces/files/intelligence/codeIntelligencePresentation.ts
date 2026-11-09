import type {
  LanguageIntelligenceDiagnostic,
  LanguageIntelligenceServerStatus,
} from '@happier-dev/protocol/machines/languageIntelligence';

import type { CodeIntelligenceSnapshot } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { t } from '@/text';

/** What a hover answer says, read once from the servers' Markdown: the signature, then the prose. */
export type CodeHoverContent = Readonly<{
  signature: Readonly<{ code: string; language: string | null }> | null;
  documentation: string | null;
  serverLabel: string | null;
}>;

const FENCE = /```([\w+-]*)\n([\s\S]*?)```/u;

/** Servers answer hovers as Markdown: the first fenced block is the signature, the rest is documentation. */
export function readCodeHoverContent(
  result: CodeIntelligenceSnapshot['result'],
): CodeHoverContent | null {
  if (!result || !('kind' in result) || result.kind !== 'hover') return null;
  let signature: CodeHoverContent['signature'] = null;
  const prose: string[] = [];
  for (const section of result.sections) {
    let markdown = section.markdown;
    if (!signature) {
      const fence = FENCE.exec(markdown);
      if (fence) {
        const code = fence[2].trim();
        if (code) signature = { code, language: fence[1] || null };
        markdown = markdown.replace(fence[0], '');
      }
    }
    const text = markdown
      .split(/\n-{3,}\n/u)
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) prose.push(text);
  }
  if (!signature && prose.length === 0) return null;
  return {
    signature,
    documentation: prose.length ? prose.join('\n\n') : null,
    serverLabel: result.sections[0]?.label ?? null,
  };
}

/** Semantic replies and fallback searches carry their own completeness facts. */
export function isCodeReferenceResultPartial(result: CodeIntelligenceSnapshot['result']): boolean {
  return Boolean(result && (
    ('hasMore' in result && result.hasMore)
    || ('coverage' in result && result.coverage === 'partial')
  ));
}

/** The language server that speaks for this file, by its own label ("TypeScript"). */
export function readLanguageServerLabel(
  servers: readonly LanguageIntelligenceServerStatus[] | undefined,
  /** The server whose answer is shown (a hover names its own); it wins over the root's first server. */
  answeredBy?: string | null,
): string | null {
  return answeredBy ?? servers?.[0]?.label ?? null;
}

export type LanguageStateNote = Readonly<{
  /** `progress` sits in the surface that asked; `failure` once under the File page header. */
  kind: 'progress' | 'failure';
  text: string;
  detail?: string;
  /** Restart a stopped server; Install opens the Machine's installables for a missing managed one. */
  action?: 'restart' | 'install';
}>;

const LAST_STDERR_LINES = 3;

/**
 * The one sentence about the language server's state (P7-R11): starting (and loading the project),
 * stopped, couldn't start, or unreachable. Healthy says nothing.
 */
export function resolveLanguageStateNote(
  input: Readonly<{
    snapshot: CodeIntelligenceSnapshot;
    machineName: string;
    machineUnreachable: boolean;
  }>,
): LanguageStateNote | null {
  const { snapshot, machineName } = input;
  const servers = snapshot.servers ?? [];
  const failed = servers.find(
    (server) =>
      server.state === 'crashed' ||
      (server.state === 'unavailable' && server.reason === 'start_failed'),
  );
  if (failed) {
    const stderr = failed.stderrPreview
      ?.trim()
      .split(/\r?\n/u)
      .slice(-LAST_STDERR_LINES)
      .join('\n');
    return {
      kind: 'failure',
      text:
        failed.state === 'crashed'
          ? t('files.pane.intelligence.serverStopped', {
              server: failed.label,
              machine: machineName,
            })
          : t('files.pane.intelligence.serverCouldNotStart', {
              server: failed.label,
              machine: machineName,
            }),
      ...(stderr ? { detail: stderr } : {}),
      action: 'restart',
    };
  }
  const missing = servers.find(
    (server) =>
      server.state === 'unavailable' && server.reason === 'server_missing',
  );
  if (missing)
    return {
      kind: 'failure',
      text: t('files.pane.intelligence.serverMissing', {
        server: missing.label,
        machine: machineName,
      }),
      ...(missing.installable ? { action: 'install' as const } : {}),
    };
  if (input.machineUnreachable && snapshot.status === 'unavailable') {
    return {
      kind: 'failure',
      text: t('files.pane.intelligence.machineOffline', {
        machine: machineName,
      }),
    };
  }
  if (
    snapshot.status === 'unavailable' &&
    snapshot.reason === 'update_required'
  ) {
    return {
      kind: 'failure',
      text: t('files.pane.intelligence.machineNeedsUpdate', {
        machine: machineName,
      }),
    };
  }
  const starting = servers.find(
    (server) =>
      server.state === 'starting' ||
      server.state === 'restarting' ||
      (server.state === 'ready' && server.loading),
  );
  if (starting || snapshot.status === 'loading') {
    const server =
      starting?.label ??
      readLanguageServerLabel(servers) ??
      t('files.pane.intelligence.languageServer');
    // A running server that is still reading the project says so; anything earlier is "Starting".
    const loadingProject = starting?.state === 'ready' && starting.loading;
    return {
      kind: 'progress',
      text: loadingProject
        ? t('files.pane.intelligence.loadingProject', { server, machine: machineName })
        : t('files.pane.intelligence.starting', { server, machine: machineName }),
      detail: t('files.pane.intelligence.startingDetail'),
    };
  }
  return null;
}

export type CodeProblemsSummary = Readonly<{
  count: number | null;
  state: 'idle' | 'ready' | 'checking' | 'unavailable';
  errors: number;
}>;

/** The File page's "3 problems" fact: only from a confirmed answer, and only when something is wrong. */
export function formatProblemsFact(
  summary: CodeProblemsSummary,
): string | null {
  if (
    summary.state !== 'ready' ||
    summary.count === null ||
    summary.count === 0
  )
    return null;
  return t('files.pane.intelligence.problemsCount', { count: summary.count });
}

export type CodeProblemGroup = Readonly<{
  serverId: string;
  serverLabel: string;
  files: readonly Readonly<{
    path: string;
    items: readonly LanguageIntelligenceDiagnostic[];
  }>[];
}>;

/** Problems by server, then by file, in reading order. */
export function groupCodeProblems(
  items: readonly LanguageIntelligenceDiagnostic[],
  servers: readonly LanguageIntelligenceServerStatus[] | undefined,
): readonly CodeProblemGroup[] {
  const byServer = new Map<
    string,
    Map<string, LanguageIntelligenceDiagnostic[]>
  >();
  for (const item of items) {
    const files =
      byServer.get(item.serverId) ??
      new Map<string, LanguageIntelligenceDiagnostic[]>();
    byServer.set(item.serverId, files);
    const list = files.get(item.path) ?? [];
    files.set(item.path, list);
    list.push(item);
  }
  return [...byServer].map(([serverId, files]) => ({
    serverId,
    serverLabel:
      servers?.find((server) => server.serverId === serverId)?.label ??
      serverId,
    files: [...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, list]) => ({
        path,
        items: [...list].sort(
          (left, right) =>
            left.range.start.line - right.range.start.line ||
            left.range.start.character - right.range.start.character,
        ),
      })),
  }));
}
