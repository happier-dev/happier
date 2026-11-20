import { describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { t } from '@/text';

import { resolveSessionViewExternalControlFooter } from './resolveSessionViewExternalControlFooter';
import { resolveSessionViewRuntimeDisplayState } from './resolveSessionViewRuntimeDisplayState';

type RuntimeInput = Parameters<typeof resolveSessionViewRuntimeDisplayState>[0];

// The external control row's Importing state, from the reader's own request before the daemon publishes an
// operation: the one fact both the row and the not-resumable notice read (C7).
const importingFooter = resolveSessionViewExternalControlFooter({
    externalSessionLink: { machineId: 'machine-1' },
    externalSessionRuntimePresentation: null,
    externalSessionIdentity: { agentLabel: 'Muse', machineLabel: 'NLDW4' },
    materializeNeeded: true,
    hasWriteAccess: true,
    externalSessionRuntime: { status: null },
    externalSessionTakeover: {
        writerSafety: 'unsupported',
        takeoverInFlight: null,
        takeoverPreflightInFlight: false,
        requestTakeoverPreflight: vi.fn(),
    },
    externalSessionMaterialize: { materializeInFlight: true, requestMaterialize: vi.fn() },
    isHiddenSystemSessionSession: false,
});

function resolveNotice(overrides: Partial<RuntimeInput>) {
    return resolveSessionViewRuntimeDisplayState({
        session: createSessionFixture({ id: `runtime-display-${Math.random()}`, active: false }),
        isSessionActive: false,
        isResumable: false,
        isMachineReachable: true,
        machineReachability: 'reachable',
        allowInputWhileInactive: false,
        externalOperationBlocksNewOperation: false,
        externalControlFooter: null,
        providerName: 'Muse',
        machineName: 'NLDW4',
        ...overrides,
    }).bottomNotice;
}

describe('resolveSessionViewRuntimeDisplayState not-resumable notice', () => {
    it('shows the shared access-withdrawal reason in the existing transcript notice', () => {
        const session = createSessionFixture({
            id: 'withdrawn-runtime-display', active: false,
            metadata: { path: '/repo', host: 'host', lifecycleState: 'stopped', lifecycleStateReason: 'machine_access_withdrawn' },
        });
        expect(resolveNotice({ session })).toEqual({
            title: t('common.inactive'), body: t('session.accessWithdrawn'),
        });
        expect(resolveNotice({ session: { ...session, metadata: { ...session.metadata!, lifecycleStateReason: undefined } } }))
            .not.toEqual(expect.objectContaining({ body: t('session.accessWithdrawn') }));
    });

    it('yields to the external control row whenever that row speaks the way forward', () => {
        expect(importingFooter).not.toBeNull();
        expect(resolveNotice({ externalControlFooter: importingFooter })).toBeNull();
    });

    it('yields to a pending operation card even when the row is withheld', () => {
        expect(resolveNotice({ externalOperationBlocksNewOperation: true })).toBeNull();
    });

    it('speaks alone when neither the row nor an operation offers a way forward', () => {
        expect(resolveNotice({})).not.toBeNull();
    });
});
