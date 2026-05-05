import type { DirectSessionsSource } from '@happier-dev/protocol';

import type { DirectBrowseCandidate } from '@/components/sessions/directSessions/browse/useDirectBrowseCandidates';

const DEMO_MACHINE_ID = 'm-macbook-pro';
const DEMO_PROJECT_PATH = '/Users/demo/code/happier';
const DEMO_OPEN_CODE_VENDOR_SESSION_ID = 'sess_opencode_auth';
const DEMO_NOW_MS = Date.parse('2026-04-24T12:00:00.000Z');

export type CreateDemoDirectBrowseCandidateFixtureOptions = Partial<DirectBrowseCandidate> & Readonly<{
    machineId?: string;
    path?: string;
    source?: DirectSessionsSource;
}>;

export function createDemoDirectBrowseCandidateFixture(
    options: CreateDemoDirectBrowseCandidateFixtureOptions = {},
): DirectBrowseCandidate {
    const {
        machineId = DEMO_MACHINE_ID,
        path = DEMO_PROJECT_PATH,
        source = { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099', directory: path },
        details: detailsOverrides,
        ...candidateOverrides
    } = options;

    return {
        remoteSessionId: DEMO_OPEN_CODE_VENDOR_SESSION_ID,
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
