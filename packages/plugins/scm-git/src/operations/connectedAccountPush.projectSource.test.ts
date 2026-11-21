import { expect, it, vi } from 'vitest';
import { runWithBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { runWithHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';

import { createScmHostingProviderRuntimeServicesForTest } from '../testkit/scmRuntime.test-support.js';
import { runGitPushWithConnectedAccount } from './connectedAccountPush.js';
import { makeCloneTargetDescription, makeProviderRegistry } from './repositoryCloneOperations.test-support.js';

const repository = 'happier-dev/happier';
const github = 'https://github.com';
const dotGitUrl = `${github}/${repository}.git`;
const result = { success: true, stdout: '', stderr: '', exitCode: 0 };

it.each([
    { destination: dotGitUrl, recordedUrl: `${github}/${repository}`, allowed: true },
    { destination: dotGitUrl, recordedUrl: undefined, allowed: true },
    { destination: `${github}:8443/${repository}.git`, recordedUrl: undefined, allowed: false },
    { destination: `${dotGitUrl}.git`, recordedUrl: undefined, allowed: false },
    { destination: dotGitUrl, recordedUrl: `${github}/${repository}-other.git`, allowed: false },
])('binds a saved GitHub Source to $destination when allowed is $allowed', async ({ destination, recordedUrl, allowed }) => {
    const description = makeCloneTargetDescription('/unused');
    const resolveCloneAuthentication = vi.fn(async () => ({ kind: 'available' as const, authorizationHeader: 'Basic fixture' }));
    const registry = makeProviderRegistry(description, { describeCloneTargets: async () => description, resolveCloneAuthentication });
    const publish = vi.fn(async () => result);
    const outcome = await runWithHostingProviderRuntimeServices(createScmHostingProviderRuntimeServicesForTest(registry), () =>
        runWithBackendRuntimeServices({
            projectFilesSource: {
                provider: description.repository.provider,
                repository: { nameWithOwner: repository, ...(recordedUrl ? { cloneUrl: recordedUrl } : {}) },
                protocol: 'https',
            },
            runCommand: async () => ({ ...result, stdout: `${destination}\n` }),
            repositoryTransport: { requiresConnectedAccount: true, run: publish },
        }, () => runGitPushWithConnectedAccount({
            remote: 'origin', command: { bin: 'git', cwd: '/fixture', args: ['push', '--no-verify', 'origin', 'main'] },
        })),
    );
    if (allowed) {
        expect(outcome.success).toBe(true);
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({
            repositories: [{ url: dotGitUrl, authorizationHeader: 'Basic fixture' }],
            command: expect.objectContaining({ args: ['push', '--no-verify', 'origin', 'main'] }),
        }));
    } else {
        expect(outcome).toMatchObject({ success: false, errorCode: 'SCM_SOURCE_CHANGED' });
        expect(resolveCloneAuthentication).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    }
});
