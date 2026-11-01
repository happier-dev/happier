import type { SessionScmChangesSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

/** How many changed files the Changes glance lists before "N more files" (lab WC: a glance, not the list). */
export const CHANGES_GLANCE_FILE_ROWS = 3;

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
 * The first {@link CHANGES_GLANCE_FILE_ROWS} changed files in the summary owner's order, and how many
 * remain. The total is the summary's real count, never the number of rows drawn.
 */
export function resolveChangesGlanceFiles(
    summary: SessionScmChangesSummary,
    maxRows: number = CHANGES_GLANCE_FILE_ROWS,
): Readonly<{ rows: readonly ChangesGlanceFileRow[]; remaining: number }> {
    const rows = summary.files.slice(0, maxRows).map((file) => {
        const { directory, name } = splitPath(file.fullPath);
        return {
            key: file.fullPath,
            letter: STATUS_LETTER[file.status],
            added: file.status === 'added' || file.status === 'untracked',
            directory,
            name,
            linesAdded: file.linesAdded,
            linesRemoved: file.linesRemoved,
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
