import type { AuthCredentials } from '../../auth/storage/authCredentials.js';

export type TerminalEnrollmentForTestOptions = Readonly<{
    connectUrl: string;
    canonicalServerUrl: string;
    homeServerIdentityId: string;
    credentials: AuthCredentials;
    waitForSuccess: () => Promise<unknown>;
}>;

// The runtime facade retains UI aliases in the UI owner's program.
export function completeTerminalConnectForTest(options: TerminalEnrollmentForTestOptions): Promise<void>;
