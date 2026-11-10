import type { SessionScmChangesSummary, SessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import type { SessionAgentActivityPhase } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { resolveScmRemoteWebLink, type ScmRemoteWebLink } from '@happier-dev/protocol/scm';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { scmChangeHasLineDelta } from '@/scm/scmLineDelta';
import { t } from '@/text';

/**
 * How many items a Companion glance lists before its "n more" (lab WC: a glance, not the list): the Changes
 * glance's files and the Running section's live agents and services.
 */
export const GLANCE_LIST_ROWS = 3;

/**
 * What the Changes glance shows. `loading` is the first read only; `notRepo` is a folder Git does
 * not track (a quiet line, not an error); `ready` carries the one summary owner's projection.
 */
export type ChangesGlanceState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'notRepo' }>
    | Readonly<{ kind: 'ready'; summary: SessionScmChangesSummary }>;

export type ChangesGlanceFileRow = Readonly<{
    key: string;
    /** One-letter status the way Git prints it (M, A, D, R, C, U, !). */
    letter: string;
    added: boolean;
    directory: string;
    name: string;
    linesAdded: number;
    linesRemoved: number;
}>;

const STATUS_LETTER: Readonly<Record<ScmFileStatus['status'], string>> = Object.freeze({
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: 'U',
    conflicted: '!',
});

function splitPath(path: string): Readonly<{ directory: string; name: string }> {
    const index = path.lastIndexOf('/');
    return index < 0 ? { directory: '', name: path } : { directory: path.slice(0, index + 1), name: path.slice(index + 1) };
}

/**
 * The first {@link GLANCE_LIST_ROWS} changed files in the summary owner's order, and how many
 * remain. The total is the summary's real count, never the number of rows drawn.
 */
export function resolveChangesGlanceFiles(
    summary: SessionScmChangesSummary,
    maxRows: number = GLANCE_LIST_ROWS,
): Readonly<{ rows: readonly ChangesGlanceFileRow[]; remaining: number }> {
    const rows = summary.files.slice(0, maxRows).map((file) => {
        const { directory, name } = splitPath(file.fullPath);
        const counted = scmChangeHasLineDelta(file);
        return {
            key: file.fullPath,
            letter: STATUS_LETTER[file.status],
            added: file.status === 'added' || file.status === 'untracked',
            directory,
            name,
            linesAdded: counted ? file.linesAdded : 0,
            linesRemoved: counted ? file.linesRemoved : 0,
        };
    });
    return { rows, remaining: Math.max(0, summary.changedFiles - rows.length) };
}

export type LocalServicesGlanceRow = Readonly<{
    id: string;
    title: string;
    /** Where it answers (":8081") or what runs it, quiet beside the name. */
    detail: string | null;
    running: boolean;
    /** Present only for a running service with an openable address. A stopped script has no action. */
    openTarget: LocalServiceLaunchTarget | null;
}>;

/**
 * The glance's rows from the ONE ranked service-row model (`buildLocalServiceRows`): this session's
 * and this workspace's user services, running first, then package scripts that are not running.
 *
 * A script that is not running reads "Not running" and offers nothing: the daemon refuses
 * package-script starts (`package_script_start_unavailable`), and running one means a new terminal
 * tab — the terminal owns that, not this glance. Happier's own listeners and other machines' services
 * stay in the pane. Machine scope instead maps every row already selected by the canonical feed,
 * including stopped declarations; it adds no Services filter.
 */
export function resolveLocalServicesGlanceRows(rows: readonly ServiceRow[], scope: 'workspace' | 'machine' = 'workspace'): readonly LocalServicesGlanceRow[] {
    const result: LocalServicesGlanceRow[] = [];
    for (const row of rows) {
        if (scope === 'workspace' && (row.internal || row.scope === 'machine')) continue;
        const running = row.status === 'running' || row.status === 'starting' || row.status === 'stale';
        const script = row.target.source === 'package_script';
        if (scope === 'workspace' && !running && !script) continue;
        result.push({
            id: row.id,
            title: row.title,
            detail: running ? (row.portLabel ?? row.processLabel) : row.processLabel ?? row.portLabel,
            running,
            openTarget: running && row.primaryAction?.kind === 'open' ? row.primaryAction.openTarget : null,
        });
    }
    return result;
}

/*
 * The Companion's row sections (lab crows B; owner ruling 2026-11-08). Each section is a built-in
 * Companion widget whose rows are facts an existing owner already holds; a row with no fact is absent,
 * never empty, and a section with no rows draws nothing.
 */

/** Environment: what changed, where it runs, which branch, and Commit while there is something to commit. */
export type EnvironmentSectionRow =
    | Readonly<{ kind: 'changes'; changedFiles: number; linesAdded: number; linesRemoved: number; hasLineChanges: boolean }>
    | Readonly<{ kind: 'place'; machine: string | null; folder: string | null }>
    | Readonly<{ kind: 'branch'; name: string }>
    | Readonly<{ kind: 'commit'; files: number }>;

export function resolveEnvironmentSectionRows(input: Readonly<{
    /** The one SCM summary owner's projection; `null` for a folder Git does not track. */
    scm: SessionScmSummary | null;
    machineName: string | null;
    folder: string | null;
}>): readonly EnvironmentSectionRow[] {
    const rows: EnvironmentSectionRow[] = [];
    const { scm } = input;
    if (scm) rows.push({ kind: 'changes', changedFiles: scm.changedFiles, linesAdded: scm.linesAdded, linesRemoved: scm.linesRemoved, hasLineChanges: scm.hasLineChanges });
    if (input.machineName || input.folder) rows.push({ kind: 'place', machine: input.machineName, folder: input.folder });
    if (scm?.branch) rows.push({ kind: 'branch', name: scm.branch });
    if (scm?.hasAnyChanges) rows.push({ kind: 'commit', files: scm.changedFiles });
    return rows;
}

/** One agent of the Session's merged activity roster, as its presentation owner names it. */
export type RunningSectionAgentInput = Readonly<{
    id: string;
    title: string;
    agentId: string | null;
    phase: SessionAgentActivityPhase;
    startedAtMs: number | null;
}>;

export type RunningSectionRows = Readonly<{
    agents: readonly RunningSectionAgentInput[];
    /** Running agents past the glance's rows; one "n more" row opens Agents. */
    moreAgents: number;
}>;

/**
 * Running agent rows follow the activity presentation's phase. Finished and idle agents stay in their
 * pane; live or attention agents past the glance's rows get one "n more" row. Service counts are already
 * projected by the passive inventory summary owner and need no detail-row projection here.
 */
export function resolveRunningSectionRows(input: Readonly<{
    agents: readonly RunningSectionAgentInput[];
    maxRows?: number;
}>): RunningSectionRows {
    const maxRows = input.maxRows ?? GLANCE_LIST_ROWS;
    const liveAgents = input.agents.filter(agent => agent.phase === 'live' || agent.phase === 'attention');
    const agents = liveAgents.slice(0, maxRows);
    return {
        agents,
        moreAgents: liveAgents.length - agents.length,
    };
}

/**
 * The Running section's header count (lab crows B): every running agent, not only the rows drawn. Services
 * say their count in their own row, which is also the way into the Services pane, so the header never
 * repeats it (lead ruling 2026-11-10).
 */
export function formatRunningSectionCount(counts: Readonly<{ agents: number }>): string | null {
    return counts.agents > 0 ? t('sessionCompanion.sections.agentsCount', { count: counts.agents }) : null;
}

/** Links: the repository's page, read from `origin` first, else the first remote that has one. */
export function resolveLinksSectionRow(remotes: readonly Readonly<{ name: string; fetchUrl?: string; pushUrl?: string }>[]): ScmRemoteWebLink | null {
    const ordered = [...remotes.filter(remote => remote.name === 'origin'), ...remotes.filter(remote => remote.name !== 'origin')];
    for (const remote of ordered) {
        const url = remote.fetchUrl ?? remote.pushUrl;
        const link = url ? resolveScmRemoteWebLink(url) : null;
        if (link) return link;
    }
    return null;
}
