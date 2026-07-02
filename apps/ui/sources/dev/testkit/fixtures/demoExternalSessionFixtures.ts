import type { ExternalSessionsSource } from '@happier-dev/protocol';

import type { ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';

const DEMO_MACHINE_ID = 'm-macbook-pro';
const DEMO_PROJECT_PATH = '/Users/demo/code/happier';
const DEMO_OPEN_CODE_PROVIDER_SESSION_ID = 'sess_opencode_auth';
const DEMO_NOW_MS = Date.parse('2026-04-24T12:00:00.000Z');

export type CreateDemoExternalSessionBrowseCandidateFixtureOptions = Partial<ExternalSessionBrowseCandidate> & Readonly<{
    machineId?: string;
    path?: string;
    source?: ExternalSessionsSource;
}>;

export function createDemoExternalSessionBrowseCandidateFixture(
    options: CreateDemoExternalSessionBrowseCandidateFixtureOptions = {},
): ExternalSessionBrowseCandidate {
    const {
        machineId = DEMO_MACHINE_ID,
        path = DEMO_PROJECT_PATH,
        source = { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099', directory: path },
        details: detailsOverrides,
        ...candidateOverrides
    } = options;

    return {
        remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
        title: 'OpenCode running on MacBook Pro',
        updatedAtMs: DEMO_NOW_MS,
        activity: 'running',
        details: {
            cwd: path,
            path,
            machineId,
            source,
            providerId: 'opencode',
            startedBy: 'daemon',
            ...(detailsOverrides ?? {}),
        },
        ...candidateOverrides,
    };
}
