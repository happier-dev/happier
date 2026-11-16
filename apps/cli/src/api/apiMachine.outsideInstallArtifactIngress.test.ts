import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { PromptExternalLinkEntryV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import * as persistence from '@/persistence';
import type { Machine } from '@/api/types';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { installMachineSkill, refreshMachineSkillInstalls, type MachineSkillInstallContent, type MachineSkillInstallResult } from '@/prompts/skills/machineInstall/machineSkillInstall';
import { refreshDemandedActivePromptLibraryCatalog } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { ApiMachineClient } from './apiMachine';

const { mockIo, axiosGet } = vi.hoisted(() => ({ mockIo: vi.fn(), axiosGet: vi.fn() }));
// Only the network and credential/cursor persistence are faked; catalog and copy owners are real.
vi.mock('socket.io-client', () => ({ io: mockIo }));
beforeEach(() => {
    vi.spyOn(axios, 'get').mockImplementation(axiosGet);
});
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readAccountChangesCursor: vi.fn(async () => 0), writeAccountChangesCursor: vi.fn(async () => {}),
}));
afterEach(() => vi.restoreAllMocks());

function skill(text: string): MachineSkillInstallContent {
    const bundleBody = { v: 1 as const, createdAtMs: 0, updatedAtMs: 0, entries: [{
        path: 'SKILL.md', contentBase64: Buffer.from(`---\nname: example\n---\n${text}`).toString('base64'), contentKind: 'utf8' as const,
    }] };
    return { skillId: 'receipted-skill', name: 'example', bundleBody, digest: computePromptBundleDigestV1(bundleBody) };
}

describe('outside-install demand and Artifact Account-change ingress', () => {
    it.each(['unedited', 'startup', 'locally-edited', 'other-machine', 'other-home', 'other-account', 'unreceipted', 'failed-read', 'lifetime-retired'] as const)(
        'refreshes only the current machine receipted Artifact (%s)', async (scenario) => {
            const homeDirectory = mkdtempSync(join(tmpdir(), 'happier-outside-install-ingress-'));
            const previous = getActiveAccountSettingsSnapshot(); const previousFlag = process.env.HAPPY_ENABLE_V2_CHANGES;
            process.env.HAPPY_ENABLE_V2_CHANGES = 'true';
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'install-account' })).toString('base64url')}.signature`, encryption: null };
            vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
            const machine: Machine = { id: 'install-machine', encryptionMode: 'plain', metadata: null,
                metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
            const context = { homeDirectory, happierHomeDirectory: join(homeDirectory, '.happier'), machineId: machine.id,
                serverIdentityId: 'srv_install-home', agents: [{ agentId: 'codex', nativeRoots: { user: [['.agents', 'skills']] } }], receipts: [] };
            const installed = installMachineSkill({ ...context, skill: skill('before'), nowMs: 1 });
            let receipts: readonly PromptExternalLinkEntryV1[] = installed.upsertReceipts;
            if (scenario === 'other-machine') receipts = receipts.map(receipt => ({ ...receipt, machineId: 'someone-else' }));
            if (scenario === 'other-home') receipts = receipts.map(receipt => ({ ...receipt, serverIdentityId: 'srv_another-home' }));
            const path = join(homeDirectory, '.agents', 'skills', 'example', 'SKILL.md');
            if (scenario === 'locally-edited') writeFileSync(path, 'my local edit');
            const record = { key: 'external-links' as const, value: { v: 1 as const, links: [...receipts] } };
            clearActiveAccountSettingsSnapshot();
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
                loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(scenario === 'other-account' ? 'another-account-token' : credentials.token),
                ...(scenario === 'startup' ? {} : {
                    promptLibraryCatalog: { status: 'ready' as const, rows: [{ record, revision: 1 }], tombstones: [], diagnostics: [] },
                }) });
            bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
            let catalogReads = 0;
            axiosGet.mockImplementation(async (url: string) => {
                const requestPath = new URL(url).pathname;
                if (requestPath === '/v1/account/profile') return { status: 200, data: { id: 'install-account' } };
                if (requestPath === '/v2/changes') return { status: 200, data: { changes: [{
                    cursor: 1, kind: 'artifact', entityId: scenario === 'unreceipted' ? 'unreceipted-skill' : 'receipted-skill', changedAt: 2, hint: null,
                }], nextCursor: 1 } };
                if (requestPath === '/v1/account/encryption/currentness') return { status: 200, data: {
                    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (requestPath === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
                if (requestPath === '/v1/account/entity-rows/prompt-library') {
                    catalogReads++;
                    if (scenario === 'failed-read') return { status: 503, data: {} };
                    if (scenario === 'lifetime-retired') {
                        clearActiveAccountSettingsSnapshot();
                        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
                            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('replacement-account') });
                    }
                    return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key,
                        revision: key === 'external-links' ? 1 : 2,
                        content: { t: 'plain', v: key === 'external-links' ? record : emptyPromptLibraryRecordV1(key) } })) } };
                }
                if (requestPath === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
                if (requestPath === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
                const historyResponse = emptyAccountSettingsHistoryCaptureResponse(requestPath);
                if (historyResponse) return historyResponse;
                throw new Error(`Unexpected outside-install request: ${requestPath}`);
            });
            let results: readonly MachineSkillInstallResult[] = [];
            const client = new ApiMachineClient(credentials.token, machine, undefined, { machineSkillInstalls: {
                target: { machineId: machine.id, serverIdentityId: 'srv_install-home' }, libraryServerIdentityId: 'srv_install-home',
                refresh: async () => {
                    const catalog = getActiveAccountSettingsSnapshot()?.promptLibraryCatalog;
                    const read = readPromptLibraryCatalogRecordV1({ catalog: catalog ?? { status: 'loading' }, key: 'external-links' });
                    if (read.status !== 'ready' || read.record.key !== 'external-links') return;
                    results = refreshMachineSkillInstalls({ ...context, receipts: read.record.value.links, skills: [skill('after')], nowMs: 2 }).results;
                },
            } });
            client.onConnectedServicesProjection(async () => {});
            try {
                await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' | 'connect' }): Promise<void> })
                    .syncChangesOnConnect({ reason: scenario === 'startup' ? 'connect' : 'live' });
                if (scenario === 'unedited' || scenario === 'startup') {
                    expect(readFileSync(path, 'utf8')).toContain('after'); expect(results[0]?.status).toBe('refreshed'); expect(catalogReads).toBeGreaterThan(0);
                } else if (scenario === 'locally-edited') {
                    expect(readFileSync(path, 'utf8')).toBe('my local edit'); expect(results[0]?.status).toBe('externally_modified');
                } else {
                    expect(readFileSync(path, 'utf8')).toContain('before'); expect(results).toEqual([]);
                    expect(catalogReads).toBe(scenario === 'failed-read' || scenario === 'lifetime-retired' ? 1 : 0);
                }
            } finally {
                await client.shutdown(); clearActiveAccountSettingsSnapshot(); if (previous) setActiveAccountSettingsSnapshot(previous);
                if (previousFlag === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES; else process.env.HAPPY_ENABLE_V2_CHANGES = previousFlag;
                rmSync(homeDirectory, { recursive: true, force: true });
            }
        },
    );

    it.each(['current', 'other-machine', 'other-home', 'other-account', 'legacy-current-home', 'legacy-other-home'] as const)(
        'retained outside-install receipts demand an unobserved catalog only in their current scope (%s)', async scenario => {
        const previous = getActiveAccountSettingsSnapshot();
        const credentials = { token: 'outside-install-demand-token', encryption: null };
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        const links = { v: 1, links: [{ id: 'receipt', artifactId: 'skill', assetTypeId: 'skills.user:.agents/skills',
            machineId: scenario === 'other-machine' ? 'elsewhere' : 'machine', scope: 'user', externalRef: { skillName: 'example' },
            ...(scenario.startsWith('legacy-') ? {} : { serverIdentityId: scenario === 'other-home' ? 'srv_elsewhere' : 'srv_home' }) }] };
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: { promptExternalLinksV1: links }, settingsVersion: 1,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(scenario === 'other-account' ? 'replacement-account' : credentials.token) });
        let catalogReads = 0;
        axiosGet.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/entity-rows/prompt-library') { catalogReads++; return { status: 200, data: { status: 'listed', rows:
                PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 2, content: { t: 'plain', v:
                    key === 'external-links' ? { key, value: links } : emptyPromptLibraryRecordV1(key) } })) } }; }
            if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            const history = emptyAccountSettingsHistoryCaptureResponse(path); if (history) return history;
            throw new Error(`Unexpected demand request: ${path}`);
        });
        try {
            await refreshDemandedActivePromptLibraryCatalog({ token: credentials.token, machineInstallDemand: {
                target: { machineId: 'machine', serverIdentityId: 'srv_home' }, libraryServerIdentityId: scenario === 'legacy-other-home' ? 'srv_elsewhere' : 'srv_home',
            } });
            const demanded = scenario === 'current' || scenario === 'legacy-current-home';
            expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog?.status).toBe(demanded ? 'ready' : undefined);
            expect(catalogReads).toBe(demanded ? 1 : 0);
        } finally { clearActiveAccountSettingsSnapshot(); if (previous) setActiveAccountSettingsSnapshot(previous); }
    });
});
