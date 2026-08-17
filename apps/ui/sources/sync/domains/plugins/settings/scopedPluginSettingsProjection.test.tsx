import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';
import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type {
    ScopedPluginSettingsAdapter,
    ScopedPluginSettingsField,
    ScopedPluginSettingsReadResult,
    ScopedPluginSettingsWriteResult,
} from './scopedPluginSettingsAdapter';
import {
    commitScopedPluginSettingsField,
    type ScopedPluginSettingsProjection,
    type ScopedPluginSettingsProjectionState,
    useScopedPluginSettingsProjection,
} from './scopedPluginSettingsProjection';

const TARGET = Object.freeze({
    kind: 'daemon' as const,
    serverIdentityId: 'server-identity-1',
    machineId: 'machine-1',
    serverId: 'server-1',
});
const ACCOUNT_TARGET = Object.freeze({
    kind: 'account' as const,
    serverIdentityId: 'server-identity-1',
});
const FIELDS = Object.freeze([
    { key: 'endpoint', redacted: false },
    { key: 'enabled', redacted: false },
]);
const GENERIC_FIELDS = Object.freeze([
    { key: 'endpoint', redacted: false, binding: { kind: 'direct' as const, settingId: 'endpoint' } },
]);
const DECLARATIVE_FIELDS = Object.freeze([
    { key: 'endpoint', redacted: false },
]);
const DECLARED_ENDPOINT_FIELD = Object.freeze({
    key: 'endpoint',
    control: 'text',
    valueType: 'string',
    valueSchema: { type: 'string' },
    title: 'Endpoint',
    secretCustody: null,
    redaction: 'none',
    clearWhenEmpty: 'persist',
    presentation: { control: 'text' },
} satisfies PluginProjectionEditableSettingField);
const DECLARED_GENERIC_ENDPOINT_FIELD = Object.freeze({
    ...DECLARED_ENDPOINT_FIELD,
    presentation: {
        control: 'text',
        binding: { kind: 'direct', settingId: 'endpoint' },
    },
} satisfies PluginProjectionEditableSettingField);
const DECLARED_GENERIC_FIELDS = Object.freeze([DECLARED_GENERIC_ENDPOINT_FIELD]);
const ACCOUNT_FIELDS = Object.freeze([
    { key: 'endpoint', redacted: false },
    { key: 'apiToken', redacted: true },
]);

function ready(
    values: Readonly<Record<string, unknown>>,
    revision: string,
): Extract<ScopedPluginSettingsReadResult, { status: 'ready' }> {
    return {
        status: 'ready',
        snapshot: {
            scope: { kind: 'daemon' },
            target: TARGET,
            revision: { kind: 'daemon', value: revision },
            values,
        },
    };
}

function readyAccount(input: Readonly<{
    endpoint: string;
    revision: number;
    secretState: 'configured' | 'missing';
}>): Extract<ScopedPluginSettingsReadResult, { status: 'ready' }> {
    return {
        status: 'ready',
        snapshot: {
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            revision: { kind: 'account', value: input.revision },
            values: { endpoint: input.endpoint },
            secretStates: { apiToken: input.secretState },
        },
    };
}

function readyAccountSecret(input: Readonly<{
    revision: number;
    secretState: 'configured' | 'missing';
}>): Extract<ScopedPluginSettingsReadResult, { status: 'ready' }> {
    return {
        status: 'ready',
        snapshot: {
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            revision: { kind: 'account-secret', value: input.revision },
            values: {},
            secretStates: { apiToken: input.secretState },
        },
    };
}

type TestAccountLifetime = ActiveServerAccountScopeLifetime & Readonly<{
    retire(): void;
}>;

function createAccountLifetime(accountId: string): TestAccountLifetime {
    let current = true;
    const cancellations = new Set<() => void>();
    const lifetime = {
        scope: Object.freeze({ serverId: 'server-profile-1', accountId }),
        isCurrent: () => current,
        onRetire(cancel: () => void) {
            if (!current) {
                cancel();
                return Object.freeze({ dispose(): void {} });
            }
            let disposed = false;
            cancellations.add(cancel);
            return Object.freeze({
                dispose(): void {
                    if (disposed) return;
                    disposed = true;
                    cancellations.delete(cancel);
                },
            });
        },
        retire(): void {
            if (!current) return;
            current = false;
            const pending = [...cancellations];
            cancellations.clear();
            for (const cancel of pending) cancel();
        },
    } satisfies TestAccountLifetime;
    return Object.freeze(lifetime);
}

const CURRENT_TEST_ACCOUNT_LIFETIME = createAccountLifetime('account-test-current');

function Harness(props: Readonly<{
    fields: readonly ScopedPluginSettingsField[];
    adapter: ScopedPluginSettingsAdapter;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    enabled?: boolean;
    declaredFields?: readonly PluginProjectionEditableSettingField[];
    sourceLifetimeIdentity?: string;
    onProjection: (projection: ScopedPluginSettingsProjection) => void;
}>) {
    const projection = useScopedPluginSettingsProjection({
        pluginId: 'acme.settings',
        scope: { kind: 'daemon' },
        target: TARGET,
        accountLifetime: props.accountLifetime ?? CURRENT_TEST_ACCOUNT_LIFETIME,
        fields: props.fields,
        ...(props.declaredFields === undefined ? {} : {
            declaredFields: props.declaredFields,
        }),
        perActiveServerIdentityId: TARGET.serverIdentityId,
        ...(props.sourceLifetimeIdentity === undefined ? {} : {
            sourceLifetimeIdentity: props.sourceLifetimeIdentity,
        }),
        enabled: props.enabled ?? true,
        adapter: props.adapter,
    });
    props.onProjection(projection);
    return null;
}

function GenericSettingsHarness(props: Readonly<{
    adapter: ScopedPluginSettingsAdapter;
    onProjection: (projection: ScopedPluginSettingsProjection) => void;
}>) {
    return (
        <Harness
            adapter={props.adapter}
            fields={GENERIC_FIELDS}
            declaredFields={DECLARED_GENERIC_FIELDS}
            onProjection={props.onProjection}
        />
    );
}

function DeclarativeSettingsHarness(props: Readonly<{
    adapter: ScopedPluginSettingsAdapter;
    onProjection: (projection: ScopedPluginSettingsProjection) => void;
}>) {
    return (
        <Harness
            adapter={props.adapter}
            fields={DECLARATIVE_FIELDS}
            onProjection={props.onProjection}
        />
    );
}

function AccountSettingsHarness(props: Readonly<{
    adapter: ScopedPluginSettingsAdapter;
    lifetime: ActiveServerAccountScopeLifetime;
    onProjection: (projection: ScopedPluginSettingsProjection) => void;
}>) {
    const params = {
        pluginId: 'acme.settings',
        scope: { kind: 'account' as const },
        target: ACCOUNT_TARGET,
        fields: ACCOUNT_FIELDS,
        enabled: true,
        adapter: props.adapter,
        accountLifetime: props.lifetime,
        perActiveServerIdentityId: null,
    };
    const projection = useScopedPluginSettingsProjection(params);
    props.onProjection(projection);
    return null;
}

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}

function projectionSlot(): ScopedPluginSettingsProjection | null {
    return null;
}

describe('useScopedPluginSettingsProjection', () => {
    it('rejects a SavedSecret bind callback retained from a retired Account lifetime', async () => {
        const accountA = createAccountLifetime('account-a');
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>();
        const adapter: ScopedPluginSettingsAdapter = {
            read: vi.fn<ScopedPluginSettingsAdapter['read']>().mockResolvedValue(readyAccountSecret({
                revision: 41,
                secretState: 'missing',
            })),
            write: writeMock,
        };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        await renderScreen(
            <AccountSettingsHarness
                adapter={adapter}
                lifetime={accountA}
                onProjection={(next) => { projection = next; }}
            />,
        );
        await flush();

        expect(projection?.state.revision).toEqual({ kind: 'account-secret', value: 41 });
        const commitFromAccountA = projection!.commit;
        await act(async () => {
            accountA.retire();
        });

        await expect(commitFromAccountA({
            fieldId: 'apiToken',
            mutation: { kind: 'bind', savedSecretId: 'secret-owned-by-account-a' },
        })).resolves.toBeNull();
        expect(writeMock).not.toHaveBeenCalled();
    });

    it('never projects a retired Account snapshot into a same-server Account while its first read is deferred', async () => {
        const accountA = createAccountLifetime('account-a');
        const accountB = createAccountLifetime('account-b');
        const accountBRead = createDeferred<ScopedPluginSettingsReadResult>();
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(readyAccount({
                endpoint: 'https://account-a.example.test',
                revision: 41,
                secretState: 'configured',
            }))
            .mockReturnValueOnce(accountBRead.promise);
        const adapter: ScopedPluginSettingsAdapter = {
            read: readMock,
            write: vi.fn<ScopedPluginSettingsAdapter['write']>(),
        };
        let accountAProjection: ScopedPluginSettingsProjection | null = projectionSlot();
        let accountBProjection: ScopedPluginSettingsProjection | null = projectionSlot();
        const accountBStates: ScopedPluginSettingsProjectionState[] = [];
        const accountAScreen = await renderScreen(
            <AccountSettingsHarness
                adapter={adapter}
                lifetime={accountA}
                onProjection={(projection) => { accountAProjection = projection; }}
            />,
        );
        await flush();

        expect(accountAProjection?.state).toMatchObject({
            values: { endpoint: 'https://account-a.example.test' },
            secretStates: { apiToken: 'configured' },
            revision: { kind: 'account', value: 41 },
            ready: true,
        });

        await act(async () => {
            accountA.retire();
        });
        expect(accountAProjection?.state).toMatchObject({
            values: {},
            secretStates: {},
            revision: null,
            ready: false,
        });
        await act(async () => {
            accountAScreen.tree.unmount();
        });
        await renderScreen(
            <AccountSettingsHarness
                adapter={adapter}
                lifetime={accountB}
                onProjection={(projection) => {
                    accountBProjection = projection;
                    accountBStates.push(projection.state);
                }}
            />,
        );

        expect(readMock).toHaveBeenCalledTimes(2);
        expect(accountBProjection?.state).toMatchObject({
            values: {},
            secretStates: {},
            revision: null,
            ready: false,
        });
        expect(accountBStates).not.toContainEqual(expect.objectContaining({
            values: expect.objectContaining({ endpoint: 'https://account-a.example.test' }),
        }));
        expect(accountBStates).not.toContainEqual(expect.objectContaining({
            secretStates: expect.objectContaining({ apiToken: 'configured' }),
        }));
        expect(accountBStates).not.toContainEqual(expect.objectContaining({
            revision: { kind: 'account', value: 41 },
        }));
        expect(accountBStates).not.toContainEqual(expect.objectContaining({ ready: true }));

        await act(async () => {
            accountBRead.resolve(readyAccount({
                endpoint: 'https://account-b.example.test',
                revision: 7,
                secretState: 'missing',
            }));
            await accountBRead.promise;
        });

        expect(accountBProjection?.state).toMatchObject({
            values: { endpoint: 'https://account-b.example.test' },
            secretStates: { apiToken: 'missing' },
            revision: { kind: 'account', value: 7 },
            ready: true,
        });
    });

    it('synchronously retires a daemon record for Account A before the same target can mount for Account B', async () => {
        const accountA = createAccountLifetime('account-a');
        const accountB = createAccountLifetime('account-b');
        const accountARefresh = createDeferred<ScopedPluginSettingsReadResult>();
        const accountBRead = createDeferred<ScopedPluginSettingsReadResult>();
        let accountAInvalidated: (() => void) | null = null;
        const accountAWatchDispose = vi.fn();
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(ready({ endpoint: 'https://account-a.example.test' }, '1'))
            .mockReturnValueOnce(accountARefresh.promise)
            .mockReturnValueOnce(accountBRead.promise);
        const watchMock = vi.fn((input: Readonly<{ onInvalidated(): void }>) => {
            if (!accountAInvalidated) {
                accountAInvalidated = input.onInvalidated;
                return { dispose: accountAWatchDispose };
            }
            return { dispose: vi.fn() };
        });
        const adapter = {
            read: readMock,
            write: vi.fn<ScopedPluginSettingsAdapter['write']>(),
            watch: watchMock,
        } as ScopedPluginSettingsAdapter;
        let accountAProjection: ScopedPluginSettingsProjection | null = projectionSlot();
        let accountBProjection: ScopedPluginSettingsProjection | null = projectionSlot();
        const accountBStates: ScopedPluginSettingsProjectionState[] = [];
        const screen = await renderScreen(
            <Harness
                fields={GENERIC_FIELDS}
                adapter={adapter}
                accountLifetime={accountA}
                onProjection={(projection) => { accountAProjection = projection; }}
            />,
        );
        await flush();

        expect(accountAProjection?.state).toMatchObject({
            values: { endpoint: 'https://account-a.example.test' },
            revision: { kind: 'daemon', value: '1' },
            ready: true,
        });
        expect(accountAInvalidated).toBeTypeOf('function');
        await act(async () => {
            accountAInvalidated?.();
            await Promise.resolve();
        });
        expect(readMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            accountA.retire();
        });
        expect(accountAWatchDispose).toHaveBeenCalledOnce();
        expect(accountAProjection?.state).toMatchObject({
            values: {},
            secretStates: {},
            revision: null,
            ready: false,
        });

        await act(async () => {
            accountAInvalidated?.();
            await Promise.resolve();
        });
        expect(readMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            screen.tree.update(
                <Harness
                    fields={GENERIC_FIELDS}
                    adapter={adapter}
                    accountLifetime={accountB}
                    onProjection={(projection) => {
                        accountBProjection = projection;
                        accountBStates.push(projection.state);
                    }}
                />,
            );
        });
        await vi.waitFor(() => expect(readMock).toHaveBeenCalledTimes(3));

        expect(accountBProjection?.state).toMatchObject({
            values: {},
            secretStates: {},
            revision: null,
            ready: false,
        });
        expect(accountBStates).not.toContainEqual(expect.objectContaining({
            values: expect.objectContaining({ endpoint: 'https://account-a.example.test' }),
        }));

        await act(async () => {
            accountARefresh.resolve(ready({ endpoint: 'https://late-account-a.example.test' }, '2'));
            await accountARefresh.promise;
        });
        expect(accountBProjection?.state.values).not.toEqual({ endpoint: 'https://late-account-a.example.test' });

        await act(async () => {
            accountBRead.resolve(ready({ endpoint: 'https://account-b.example.test' }, '7'));
            await accountBRead.promise;
        });
        expect(accountBProjection?.state).toMatchObject({
            values: { endpoint: 'https://account-b.example.test' },
            revision: { kind: 'daemon', value: '7' },
            ready: true,
        });
    });

    it('shares one record watch and refreshes mounted generic and declarative consumers after an external mutation', async () => {
        let externalValue = 'Before';
        let externalRevision = '0';
        let onInvalidated: (() => void) | null = null;
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>(() => Promise.resolve(
            ready({ endpoint: externalValue }, externalRevision),
        ));
        const watchMock = vi.fn((input: Readonly<{ onInvalidated(): void }>) => {
            onInvalidated = input.onInvalidated;
            return { dispose: vi.fn() };
        });
        const adapter = {
            read: readMock,
            write: vi.fn<ScopedPluginSettingsAdapter['write']>(),
            watch: watchMock,
        } as ScopedPluginSettingsAdapter;
        let generic: ScopedPluginSettingsProjection | null = projectionSlot();
        let declarative: ScopedPluginSettingsProjection | null = projectionSlot();

        await renderScreen(
            <>
                <GenericSettingsHarness adapter={adapter} onProjection={(next) => { generic = next; }} />
                <DeclarativeSettingsHarness adapter={adapter} onProjection={(next) => { declarative = next; }} />
            </>,
        );
        await flush();

        const readsBeforeExternalMutation = readMock.mock.calls.length;
        expect(readsBeforeExternalMutation).toBeGreaterThan(0);
        expect(watchMock).toHaveBeenCalledOnce();
        expect(generic?.state.values).toEqual({ endpoint: 'Before' });
        expect(declarative?.state.values).toEqual({ endpoint: 'Before' });

        externalValue = 'Changed elsewhere';
        externalRevision = '1';
        await act(async () => {
            onInvalidated?.();
        });
        await flush();

        expect(readMock).toHaveBeenCalledTimes(readsBeforeExternalMutation + 1);
        expect(generic?.state.values).toEqual({ endpoint: 'Changed elsewhere' });
        expect(declarative?.state.values).toEqual({ endpoint: 'Changed elsewhere' });
    });

    it('keeps generic and declarative ordinary controls on one field pending CAS owner', async () => {
        const pendingWrite = createDeferred<ScopedPluginSettingsWriteResult>();
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>()
            .mockReturnValueOnce(pendingWrite.promise);
        const adapter: ScopedPluginSettingsAdapter = {
            read: vi.fn<ScopedPluginSettingsAdapter['read']>().mockResolvedValue(
                ready({ endpoint: 'https://before.example.test' }, '0'),
            ),
            write: writeMock,
        };
        let generic: ScopedPluginSettingsProjection | null = projectionSlot();
        let declarative: ScopedPluginSettingsProjection | null = projectionSlot();

        await renderScreen(
            <>
                <GenericSettingsHarness adapter={adapter} onProjection={(next) => { generic = next; }} />
                <DeclarativeSettingsHarness adapter={adapter} onProjection={(next) => { declarative = next; }} />
            </>,
        );
        await flush();

        expect(generic?.fieldModels).toHaveLength(1);
        const genericField = generic!.fieldModels[0]!;
        expect(genericField.value).toBe('https://before.example.test');
        expect(declarative?.state.values.endpoint).toBe('https://before.example.test');

        let genericCommit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            genericCommit = generic!.fieldModels[0]!.commit({
                draft: 'https://changed.example.test',
            });
        });

        expect(writeMock).toHaveBeenCalledOnce();
        expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://changed.example.test' },
            expectedRevision: { kind: 'daemon', value: '0' },
        }));
        expect(generic!.fieldModels[0]!.pending).toBe(true);
        expect(declarative!.state.writePending).toBe(true);
        let competingCommit: ScopedPluginSettingsWriteResult | null = null;
        await act(async () => {
            declarative!.setDraft('endpoint', 'https://competing.example.test');
            competingCommit = await declarative!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://competing.example.test' },
            });
        });
        expect(competingCommit).toBeNull();
        expect(writeMock).toHaveBeenCalledOnce();

        await act(async () => {
            pendingWrite.resolve(ready({ endpoint: 'https://changed.example.test' }, '1'));
            await genericCommit!;
        });
        expect(generic!.fieldModels[0]!.pending).toBe(false);
        expect(declarative!.state.writePending).toBe(false);
        expect(generic!.state).toMatchObject({
            values: { endpoint: 'https://changed.example.test' },
            revision: { kind: 'daemon', value: '1' },
        });
        expect(declarative!.state).toMatchObject({
            values: { endpoint: 'https://changed.example.test' },
            revision: { kind: 'daemon', value: '1' },
        });
    });

    it('keeps an ordinary draft visible but inert after its declaration source is replaced', async () => {
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>().mockResolvedValue(
            ready({ endpoint: 'https://replacement.example.test' }, '2'),
        );
        const adapter: ScopedPluginSettingsAdapter = {
            read: vi.fn<ScopedPluginSettingsAdapter['read']>()
                .mockResolvedValueOnce(ready({ endpoint: 'https://before.example.test' }, '0'))
                .mockResolvedValueOnce(ready({ endpoint: 'https://replacement.example.test' }, '1')),
            write: writeMock,
        };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        const screen = await renderScreen(
            <Harness
                fields={GENERIC_FIELDS}
                declaredFields={DECLARED_GENERIC_FIELDS}
                sourceLifetimeIdentity="generation-a"
                adapter={adapter}
                onProjection={(next) => { projection = next; }}
            />,
        );
        await flush();

        act(() => {
            projection!.fieldModels[0]!.setDraft('https://generation-a-draft.example.test');
        });
        expect(projection!.fieldModels[0]).toMatchObject({
            draft: 'https://generation-a-draft.example.test',
            dirty: true,
        });

        await act(async () => {
            screen.tree.update(
                <Harness
                    fields={GENERIC_FIELDS}
                    declaredFields={DECLARED_GENERIC_FIELDS}
                    sourceLifetimeIdentity="generation-b"
                    adapter={adapter}
                    onProjection={(next) => { projection = next; }}
                />,
            );
        });
        await flush();

        expect(projection!.fieldModels[0]).toMatchObject({
            value: 'https://replacement.example.test',
            draft: 'https://generation-a-draft.example.test',
            dirty: false,
        });
        await expect(projection!.fieldModels[0]!.commit()).resolves.toBeNull();
        expect(writeMock).not.toHaveBeenCalled();

        let currentCommit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            currentCommit = projection!.fieldModels[0]!.commit({
                draft: 'https://generation-b-draft.example.test',
            });
        });
        await act(async () => {
            await currentCommit!;
        });
        expect(writeMock).toHaveBeenCalledOnce();
        expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({
            mutation: { kind: 'set', value: 'https://generation-b-draft.example.test' },
            expectedRevision: { kind: 'daemon', value: '1' },
        }));
    });

    it('adopts one adapter-owned safe readback while retaining an unknown write outcome', async () => {
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>().mockResolvedValue(
            ready({ endpoint: 'https://before.example.test' }, '7'),
        );
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>().mockResolvedValue({
            status: 'outcomeUnknown',
            snapshot: ready({ endpoint: 'https://possibly-applied.example.test' }, '8').snapshot,
        });
        const adapter: ScopedPluginSettingsAdapter = { read: readMock, write: writeMock };
        let generic: ScopedPluginSettingsProjection | null = projectionSlot();

        await renderScreen(
            <GenericSettingsHarness adapter={adapter} onProjection={(next) => { generic = next; }} />,
        );
        await flush();

        let commit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            commit = generic!.fieldModels[0]!.commit({
                draft: 'https://possibly-applied.example.test',
            });
        });
        await act(async () => {
            await commit!;
        });

        expect(writeMock).toHaveBeenCalledOnce();
        // The adapter already performed the only safe readback. The shared
        // record adopts that snapshot and must not make a second recovery read.
        expect(readMock).toHaveBeenCalledOnce();
        expect(generic!.state).toMatchObject({
            values: { endpoint: 'https://possibly-applied.example.test' },
            revision: { kind: 'daemon', value: '8' },
            error: 'outcomeUnknown',
        });
        expect(generic!.fieldModels[0]!.error).toBe('outcomeUnknown');
    });

    it('refreshes a same-record declaration projection without letting an older field write overwrite a refreshed sibling', async () => {
        const refresh = createDeferred<ScopedPluginSettingsReadResult>();
        const write = createDeferred<ScopedPluginSettingsWriteResult>();
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(ready({ endpoint: 'https://one.example.test', enabled: true }, '1'))
            .mockReturnValueOnce(refresh.promise);
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>()
            .mockReturnValueOnce(write.promise);
        const adapter: ScopedPluginSettingsAdapter = { read: readMock, write: writeMock };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        await renderScreen(
            <Harness fields={FIELDS} adapter={adapter} onProjection={(next) => { projection = next; }} />,
        );
        await flush();

        if (!projection) throw new Error('Expected scoped projection');
        let commit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            projection!.setDraft('endpoint', 'https://next.example.test');
            commit = projection!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://next.example.test' },
            });
        });
        expect(writeMock).toHaveBeenCalledOnce();

        let currentRefresh: Promise<void>;
        act(() => {
            currentRefresh = projection!.refresh();
        });
        expect(readMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            refresh.resolve(ready({ endpoint: 'https://one.example.test', enabled: false }, '2'));
            await currentRefresh!;
        });
        expect(projection!.state.values).toEqual({ endpoint: 'https://one.example.test', enabled: false });
        expect(projection!.state.writePending).toBe(true);

        await act(async () => {
            write.resolve(ready({ endpoint: 'https://next.example.test', enabled: true }, '3'));
            await commit!;
        });
        expect(projection!.state.values).toEqual({ endpoint: 'https://next.example.test', enabled: false });
        expect(projection!.state.writePending).toBe(false);
    });

    it('does not retain a removed field draft or pending write when that declaration is later reintroduced', async () => {
        const removedFieldWrite = createDeferred<ScopedPluginSettingsWriteResult>();
        const reintroducedFieldWrite = createDeferred<ScopedPluginSettingsWriteResult>();
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(ready({ endpoint: 'https://one.example.test', enabled: true }, '1'))
            .mockResolvedValueOnce(ready({ endpoint: 'https://two.example.test' }, '2'))
            .mockResolvedValueOnce(ready({ endpoint: 'https://three.example.test', enabled: true }, '3'));
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>()
            .mockReturnValueOnce(removedFieldWrite.promise)
            .mockReturnValueOnce(reintroducedFieldWrite.promise);
        const adapter: ScopedPluginSettingsAdapter = { read: readMock, write: writeMock };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        const screen = await renderScreen(
            <Harness fields={FIELDS} adapter={adapter} onProjection={(next) => { projection = next; }} />,
        );
        await flush();

        if (!projection) throw new Error('Expected scoped projection');
        let commit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            projection!.setDraft('enabled', false);
            commit = projection!.commit({ fieldId: 'enabled', mutation: { kind: 'set', value: false } });
        });

        await act(async () => {
            screen.tree.update(
                <Harness
                    fields={[FIELDS[0]!].map((field) => ({ ...field }))}
                    adapter={adapter}
                    onProjection={(next) => { projection = next; }}
                />,
            );
        });
        await flush();
        await act(async () => {
            screen.tree.update(
                <Harness
                    fields={FIELDS.map((field) => ({ ...field }))}
                    adapter={adapter}
                    onProjection={(next) => { projection = next; }}
                />,
            );
        });
        await flush();

        expect(readMock).toHaveBeenCalledTimes(3);
        expect(projection!.state.values).toEqual({ endpoint: 'https://three.example.test', enabled: true });
        expect(projection!.state.drafts).toMatchObject({ enabled: true });
        // The removed declaration retires only its own old write. A later
        // reintroduction is a fresh field lifetime, not a lock held by the
        // obsolete callback.
        expect(projection!.state.writePending).toBe(false);

        let currentCommit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            projection!.setDraft('enabled', false);
            currentCommit = projection!.commit({ fieldId: 'enabled', mutation: { kind: 'set', value: false } });
        });
        expect(writeMock).toHaveBeenCalledTimes(2);
        expect(projection!.state.writePending).toBe(true);

        let staleCompletion: ScopedPluginSettingsWriteResult | null = null;
        await act(async () => {
            removedFieldWrite.resolve(ready({ endpoint: 'https://one.example.test', enabled: false }, '4'));
            staleCompletion = await commit!;
        });
        expect(staleCompletion).toBeNull();
        expect(projection!.state.writePending).toBe(true);
        expect(projection!.state.values).toEqual({ endpoint: 'https://three.example.test', enabled: true });

        await act(async () => {
            reintroducedFieldWrite.resolve(ready({ endpoint: 'https://three.example.test', enabled: false }, '4'));
            await currentCommit!;
        });
        expect(projection!.state.writePending).toBe(false);
        expect(projection!.state.values).toEqual({ endpoint: 'https://three.example.test', enabled: false });
    });

    it('rejects an overlapping write from a stale callback on the same record', async () => {
        const firstWrite = createDeferred<ScopedPluginSettingsWriteResult>();
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(ready({ endpoint: 'https://before.example.test', enabled: true }, '0'));
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>()
            .mockReturnValueOnce(firstWrite.promise)
            .mockResolvedValueOnce(ready({ endpoint: 'https://unexpected.example.test', enabled: true }, '1'));
        const adapter: ScopedPluginSettingsAdapter = { read: readMock, write: writeMock };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        await renderScreen(
            <Harness fields={FIELDS} adapter={adapter} onProjection={(next) => { projection = next; }} />,
        );
        await flush();

        if (!projection) throw new Error('Expected scoped projection');
        let firstCommit: Promise<ScopedPluginSettingsWriteResult | null>;
        let staleCommit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            firstCommit = projection!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://first.example.test' },
            });
            // A renderer can retain an old callback even after the current
            // control becomes disabled. The shared record remains the one
            // serializing authority for that callback.
            staleCommit = projection!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://unexpected.example.test' },
            });
        });

        expect(writeMock).toHaveBeenCalledOnce();
        await expect(staleCommit!).resolves.toBeNull();

        await act(async () => {
            firstWrite.resolve(ready({ endpoint: 'https://first.example.test', enabled: true }, '1'));
            await firstCommit!;
        });
        expect(projection!.state.values).toEqual({ endpoint: 'https://first.example.test', enabled: true });
    });

    it('serializes an imperative field writer with the mounted scoped record owner', async () => {
        const mountedWrite = createDeferred<ScopedPluginSettingsWriteResult>();
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(ready({ endpoint: 'https://before.example.test' }, '0'));
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>()
            .mockReturnValueOnce(mountedWrite.promise);
        const adapter: ScopedPluginSettingsAdapter = { read: readMock, write: writeMock };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        await renderScreen(
            <Harness fields={GENERIC_FIELDS} adapter={adapter} onProjection={(next) => { projection = next; }} />,
        );
        await flush();

        let mountedCommit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            mountedCommit = projection!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://mounted.example.test' },
            });
        });

        let imperativeResult: ScopedPluginSettingsWriteResult | null = null;
        await act(async () => {
            imperativeResult = await commitScopedPluginSettingsField({
                pluginId: 'acme.settings',
                scope: { kind: 'daemon' },
                target: TARGET,
                accountLifetime: CURRENT_TEST_ACCOUNT_LIFETIME,
                fields: GENERIC_FIELDS,
                adapter,
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://imperative.example.test' },
            });
        });

        expect(imperativeResult).toBeNull();
        expect(writeMock).toHaveBeenCalledOnce();

        await act(async () => {
            mountedWrite.resolve(ready({ endpoint: 'https://mounted.example.test' }, '1'));
            await mountedCommit!;
        });
        expect(projection!.state.values).toEqual({ endpoint: 'https://mounted.example.test' });
    });

    it('replaces a failed draft when one recovery read returns a newer authoritative revision', async () => {
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(ready({ endpoint: 'https://before.example.test', enabled: true }, '0'))
            .mockResolvedValueOnce(ready({ endpoint: 'https://external.example.test', enabled: true }, '1'));
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>()
            .mockResolvedValueOnce({ status: 'unavailable', reason: 'transport' });
        const adapter: ScopedPluginSettingsAdapter = { read: readMock, write: writeMock };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        await renderScreen(
            <Harness fields={FIELDS} adapter={adapter} onProjection={(next) => { projection = next; }} />,
        );
        await flush();

        if (!projection) throw new Error('Expected scoped projection');
        let result: ScopedPluginSettingsWriteResult | null = null;
        await act(async () => {
            projection!.setDraft('endpoint', 'https://failed.example.test');
            result = await projection!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://failed.example.test' },
            });
        });

        expect(result).toEqual({ status: 'unavailable', reason: 'transport' });
        expect(readMock).toHaveBeenCalledTimes(2);
        expect(projection!.state.values).toEqual({ endpoint: 'https://external.example.test', enabled: true });
        expect(projection!.state.drafts).toMatchObject({ endpoint: 'https://external.example.test' });
        expect(projection!.state.error).toBe('failed');
    });

    it('retires a pending write when every subscriber loses current admission before reconnect', async () => {
        const staleWrite = createDeferred<ScopedPluginSettingsWriteResult>();
        const currentWrite = createDeferred<ScopedPluginSettingsWriteResult>();
        const readMock = vi.fn<ScopedPluginSettingsAdapter['read']>()
            .mockResolvedValueOnce(ready({ endpoint: 'https://before.example.test', enabled: true }, '0'))
            .mockResolvedValueOnce(ready({ endpoint: 'https://reconnected.example.test', enabled: true }, '1'));
        const writeMock = vi.fn<ScopedPluginSettingsAdapter['write']>()
            .mockReturnValueOnce(staleWrite.promise)
            .mockReturnValueOnce(currentWrite.promise);
        const adapter: ScopedPluginSettingsAdapter = { read: readMock, write: writeMock };
        let projection: ScopedPluginSettingsProjection | null = projectionSlot();
        const screen = await renderScreen(
            <Harness fields={FIELDS} adapter={adapter} enabled onProjection={(next) => { projection = next; }} />,
        );
        await flush();

        if (!projection) throw new Error('Expected scoped projection');
        let commit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            commit = projection!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://stale.example.test' },
            });
        });
        expect(writeMock).toHaveBeenCalledOnce();
        expect(projection!.state.writePending).toBe(true);

        await act(async () => {
            screen.tree.update(
                <Harness fields={FIELDS} adapter={adapter} enabled={false} onProjection={(next) => { projection = next; }} />,
            );
        });
        await flush();

        // Going offline retires the record's current authority. The old write
        // cannot keep a reconnected surface locked while its transport settles.
        expect(projection!.state.writePending).toBe(false);

        await act(async () => {
            screen.tree.update(
                <Harness fields={FIELDS} adapter={adapter} enabled onProjection={(next) => { projection = next; }} />,
            );
        });
        await flush();

        let currentCommit: Promise<ScopedPluginSettingsWriteResult | null>;
        act(() => {
            currentCommit = projection!.commit({
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://current.example.test' },
            });
        });
        expect(writeMock).toHaveBeenCalledTimes(2);
        expect(projection!.state.writePending).toBe(true);

        let staleCompletion: ScopedPluginSettingsWriteResult | null = null;
        await act(async () => {
            staleWrite.resolve(ready({ endpoint: 'https://stale.example.test', enabled: true }, '2'));
            staleCompletion = await commit!;
        });

        expect(staleCompletion).toBeNull();
        expect(projection!.state.writePending).toBe(true);
        expect(projection!.state.values).toEqual({ endpoint: 'https://reconnected.example.test', enabled: true });

        await act(async () => {
            currentWrite.resolve(ready({ endpoint: 'https://current.example.test', enabled: true }, '2'));
            await currentCommit!;
        });
        expect(projection!.state.writePending).toBe(false);
        expect(projection!.state.values).toEqual({ endpoint: 'https://current.example.test', enabled: true });
    });
});
