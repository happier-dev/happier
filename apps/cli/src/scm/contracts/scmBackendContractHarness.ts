import {
    createScmCapabilitiesFromBackendCapabilities,
    type ScmBackendCapabilities,
    type ScmRepoMode,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveScmBackendCapabilities } from '../capabilities/resolveScmBackendCapabilities';
import type { ScmBackend, ScmBackendContext } from '../types';
import {
    assertGroupedCapabilities,
    assertSupportedResult,
    assertUnsupportedCapabilityLeaf,
    getCapabilityLeaf,
    listCapabilityLeaves,
    type ScmBackendCapabilityLeafPath,
} from './scmBackendContractAssertions';
import { assertScmBackendContractLeafCoverage } from './scmBackendContractCoverage';
import {
    checkExecutableAvailability,
    createLocalScmRepositoryFixture,
    createScmContractTempDirectory,
    createUnsupportedScmBackendMethodFixture,
    type ScmBackendRepositoryFixture,
} from './scmBackendContractFixtures';
import { createScmBackendCapabilityLeafAccounts } from './scmBackendContractLeafAccounts';
import type { ScmBackendContractLeafAccount } from './scmBackendContractCoverage';

export type ScmBackendContractSuiteInput = Readonly<{
    createBackend: () => ScmBackend | Promise<ScmBackend>;
    executable: string;
    repoMode: ScmRepoMode;
    supportsExecutableMissingDiagnostic: boolean;
}>;

function createContext(
    backend: ScmBackend,
    cwd: string,
    detection: ScmBackendContext['detection'],
): ScmBackendContext {
    return {
        cwd,
        projectKey: `${backend.id}:${cwd}`,
        detection,
    };
}

function expectLeafSupported(capabilities: ScmBackendCapabilities, path: ScmBackendCapabilityLeafPath): boolean {
    const leaf = getCapabilityLeaf(capabilities, path);
    return leaf?.support === 'supported' || leaf?.support === 'experimental';
}

function requireDeclaredCapabilities(backend: ScmBackend): ScmBackendCapabilities {
    expect(backend.declaredCapabilities).toBeDefined();
    if (!backend.declaredCapabilities) {
        throw new Error(`${backend.id} backend must declare grouped capabilities`);
    }
    return assertGroupedCapabilities(backend.declaredCapabilities);
}

export function shouldRunScmBackendLeafAccount(input: Readonly<{
    account: ScmBackendContractLeafAccount;
    executableAvailable: boolean;
}>): boolean {
    return input.executableAvailable
        || (input.account.kind === 'unsupported-method' && input.account.requiresExecutable === false);
}

function createAccountFixture(input: Readonly<{
    backend: ScmBackend;
    executable: string;
    executableAvailable: boolean;
    repoMode: ScmRepoMode;
}>): ScmBackendRepositoryFixture {
    if (!input.executableAvailable) {
        return createUnsupportedScmBackendMethodFixture(`happier-scm-contract-${input.backend.id}-unsupported-`);
    }

    return createLocalScmRepositoryFixture({
        executable: input.executable,
        repoMode: input.repoMode,
        prefix: `happier-scm-contract-${input.backend.id}-`,
    });
}

async function createAccountContext(input: Readonly<{
    backend: ScmBackend;
    fixture: ScmBackendRepositoryFixture;
    executableAvailable: boolean;
}>): Promise<ScmBackendContext> {
    if (!input.executableAvailable) {
        return createContext(input.backend, input.fixture.rootPath, {
            isRepo: false,
            rootPath: null,
            mode: null,
        });
    }

    const detection = await input.backend.detectRepo({ cwd: input.fixture.rootPath });
    return createContext(input.backend, input.fixture.rootPath, detection);
}

export function runScmBackendContractSuite(input: ScmBackendContractSuiteInput): void {
    const availability = checkExecutableAvailability(input.executable);
    const leafAccounts = createScmBackendCapabilityLeafAccounts({ repoMode: input.repoMode });

    it('declares parseable grouped capabilities with every canonical group', async () => {
        const backend = await input.createBackend();
        const capabilities = requireDeclaredCapabilities(backend);
        expect(listCapabilityLeaves(capabilities).length).toBeGreaterThan(0);
        assertScmBackendContractLeafCoverage({
            backendId: backend.id,
            capabilities,
            accounts: leafAccounts,
        });
    });

    if (!availability.available) {
        it('reports executable-missing capabilities without hiding the backend contract', async () => {
            const backend = await input.createBackend();
            expect(input.supportsExecutableMissingDiagnostic).toBe(true);
            const capabilities = requireDeclaredCapabilities(backend);
            const resolved = resolveScmBackendCapabilities({
                declaredCapabilities: capabilities,
                mode: input.repoMode,
                supportedRepoModes: [input.repoMode],
                executableAvailable: false,
            });
            expect(getCapabilityLeaf(resolved, { group: 'detection', leaf: 'executable' })?.reason).toBe('tool_missing');
            expect(createScmCapabilitiesFromBackendCapabilities(resolved).readStatus).toBe(false);
        });
    }

    if (input.supportsExecutableMissingDiagnostic) {
        it('projects executable-missing diagnostics through backend capabilities', async () => {
            const backend = await input.createBackend();
            const projected = backend.getCapabilities({
                mode: input.repoMode,
                executableAvailable: false,
            } as Parameters<ScmBackend['getCapabilities']>[0] & { executableAvailable: false });

            expect(projected.readStatus).toBe(false);
            expect(projected.writeRemotePush).toBe(false);
        });
    }

    if (availability.available) {
        describe('repository detection', () => {
            it('returns not-a-repo outside a repository', async () => {
                const backend = await input.createBackend();
                const workspace = createScmContractTempDirectory('happier-scm-contract-empty-');
                const detection = await backend.detectRepo({ cwd: workspace });

                expect(detection).toEqual({
                    isRepo: false,
                    rootPath: null,
                    mode: null,
                });
            });

            it('detects repository root and nested directories', async () => {
                const backend = await input.createBackend();
                const fixture = createLocalScmRepositoryFixture({
                    executable: input.executable,
                    repoMode: input.repoMode,
                    prefix: `happier-scm-contract-${backend.id}-`,
                });

                const rootDetection = await backend.detectRepo({ cwd: fixture.rootPath });
                const nestedDetection = await backend.detectRepo({ cwd: fixture.nestedPath });

                expect(rootDetection).toMatchObject({
                    isRepo: true,
                    rootPath: fixture.rootPath,
                    mode: input.repoMode,
                });
                expect(nestedDetection).toMatchObject({
                    isRepo: true,
                    rootPath: fixture.rootPath,
                    mode: input.repoMode,
                });
            });
        });

        it('projects legacy capabilities from grouped capabilities for the repository mode', async () => {
            const backend = await input.createBackend();
            const fixture = createLocalScmRepositoryFixture({
                executable: input.executable,
                repoMode: input.repoMode,
                prefix: `happier-scm-contract-${backend.id}-`,
            });
            const detection = await backend.detectRepo({ cwd: fixture.rootPath });
            const context = createContext(backend, fixture.rootPath, detection);
            const described = await backend.describeBackend({
                context,
                request: { cwd: fixture.rootPath },
            });

            assertSupportedResult(described);
            expect(described.capabilities).toEqual(backend.getCapabilities({ mode: input.repoMode }));
        });

        it('does not surface ignored files in status snapshots', async () => {
            const backend = await input.createBackend();
            const fixture = createLocalScmRepositoryFixture({
                executable: input.executable,
                repoMode: input.repoMode,
                prefix: `happier-scm-contract-${backend.id}-`,
            });
            const detection = await backend.detectRepo({ cwd: fixture.rootPath });
            const context = createContext(backend, fixture.rootPath, detection);
            const status = await backend.statusSnapshot({
                context,
                request: { cwd: fixture.rootPath },
            });

            assertSupportedResult(status);
            expect(status.snapshot?.entries.map((entry) => entry.path)).not.toContain(fixture.ignoredPath);
        });
    }

    for (const account of leafAccounts) {
        if (!shouldRunScmBackendLeafAccount({ account, executableAvailable: availability.available })) {
            continue;
        }

        it(`accounts for ${account.path.group}.${account.path.leaf} capability leaf`, async () => {
            const backend = await input.createBackend();
            const capabilities = requireDeclaredCapabilities(backend);
            const fixture = createAccountFixture({
                backend,
                executable: input.executable,
                executableAvailable: availability.available,
                repoMode: input.repoMode,
            });
            const context = await createAccountContext({
                backend,
                executableAvailable: availability.available,
                fixture,
            });

            if (account.kind === 'no-backend-method' || account.kind === 'blocked') {
                expect(account.rationale?.trim()).toBeTruthy();
                if (!expectLeafSupported(capabilities, account.path)) {
                    assertUnsupportedCapabilityLeaf(capabilities, account.path);
                }
                return;
            }

            if (expectLeafSupported(capabilities, account.path)) {
                expect(account.assertSupported).toBeTypeOf('function');
                if (!account.assertSupported) return;
                await account.assertSupported({ backend, context, fixture });
                return;
            }

            assertUnsupportedCapabilityLeaf(capabilities, account.path);
            expect(account.assertUnsupported).toBeTypeOf('function');
            if (!account.assertUnsupported) return;
            await account.assertUnsupported({ backend, context, fixture });
        });
    }
}
