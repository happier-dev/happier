import { describe, expect, it } from 'vitest';

import { resolveTerminationArchiveDecision } from './lifecycle/terminationArchivePolicy';

describe('resolveTerminationArchiveDecision', () => {
    it('does not archive daemon-started sessions on a clean normal exit', () => {
        expect(resolveTerminationArchiveDecision({
            startedBy: 'daemon',
            event: { kind: 'exit', code: 0 },
            outcome: { exitCode: 0, archive: true, archiveReason: 'Exited normally' },
        })).toEqual({ archive: false, archiveReason: null });
    });

    it('does not archive daemon-started sessions on SIGTERM', () => {
        expect(resolveTerminationArchiveDecision({
            startedBy: 'daemon',
            event: { kind: 'signal', signal: 'SIGTERM' },
            outcome: { exitCode: 0, archive: true, archiveReason: 'Signal SIGTERM' },
        })).toEqual({ archive: false, archiveReason: null });
    });

    it('does not archive sessions when the user explicitly stops them', () => {
        expect(resolveTerminationArchiveDecision({
            startedBy: 'daemon',
            event: { kind: 'killSession' },
            outcome: { exitCode: 0, archive: true, archiveReason: 'Killed by user' },
        })).toEqual({ archive: false, archiveReason: null });
    });

    it('keeps terminal-started killSession archiving behavior unchanged', () => {
        expect(resolveTerminationArchiveDecision({
            startedBy: 'terminal',
            event: { kind: 'killSession' },
            outcome: { exitCode: 0, archive: true, archiveReason: 'Killed by user' },
        })).toEqual({ archive: true, archiveReason: 'Killed by user' });
    });

    it('keeps terminal-started clean-exit archiving behavior unchanged', () => {
        expect(resolveTerminationArchiveDecision({
            startedBy: 'terminal',
            event: { kind: 'exit', code: 0 },
            outcome: { exitCode: 0, archive: true, archiveReason: 'Exited normally' },
        })).toEqual({ archive: true, archiveReason: 'Exited normally' });
    });
});
