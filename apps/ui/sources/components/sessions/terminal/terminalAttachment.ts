import type { SessionTerminalTargetV1 } from '@happier-dev/protocol/terminal/workspace';

/** Attachment input belongs to the supervisor's target, never the presenting surface. */
export function isTerminalTargetReadOnly(target: SessionTerminalTargetV1 | undefined): boolean {
    return target?.kind === 'terminal_view' && target.interactive !== true;
}
