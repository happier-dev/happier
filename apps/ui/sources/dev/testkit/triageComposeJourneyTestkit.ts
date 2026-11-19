import { randomUUID } from 'node:crypto';
import { act, cloneElement, createElement, isValidElement, useEffect, useMemo, type ReactNode } from 'react';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { ComposerAttachmentDraftV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { normalizePluginUiMountedContributedActionReferenceV1,
    PluginUiReadComposerResultV1Schema, PluginUiApplyComposerResultV1Schema, PluginUiJsonValueV1Schema,
    type PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit, type PluginUiTestkitHostHandlers,
    type PluginUiSemanticSurfaceMount } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { ComposerAttachmentAuthorPresentationV1, RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { useComposer } from '@happier-dev/plugin-ui';
import { PluginUiPresentationHostProviderInternal, useOptionalPluginUiPresentationHost,
    type PluginUiTargetedSurfacePresentation } from '../../../../../packages/plugin-ui/src/presentationHost/context';
import { TRIAGE_APP_PAGE_DESTINATION_V1, type TriageEntryRefV1, type TriageSourceInstanceRefV1 } from '@happier-dev/triage-protocol/v1';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readMountedAccountTargetedContributions } from '@/components/plugins/surfaces/mountedAccountTargetedContributions';
import { prepareTargetedSurfaceMounts } from '@/components/plugins/surfaces/mountedTargetedContributions';
import { createTargetedPluginSurfaceBoundFacts, readTargetedPluginSurfaceReactMountRequest } from '@/components/plugins/surfaces/TargetedPluginSurfaceHost';
import { createBoundPluginSurfaceController } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { createNewSessionComposerDocumentOwner } from '@/components/sessions/composer/newSessionComposerDocumentOwner';
import { projectComposerDocumentSnapshot } from '@/components/sessions/composer/composerSnapshotProjection';
import { buildComposerSnapshotStructuredInputMetaOverrides } from '@/components/sessions/composer/composerScopeAdapters';
import { createComposerPresentationHostHandlers, createComposerPresentationTransactionApplier,
    registerComposerPresentationTarget, notifyComposerPresentationTargetChanged } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { createComposersService } from '../../../../../packages/plugin-ui/src/composer/service';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { renderSurface } from '../../../../../packages/plugins/triage/src/composer/entryPicker';
import { renderSurface as renderTriagePage } from '../../../../../packages/plugins/triage/src/ui/surface';
import { refreshTriageListWindow } from '../../../../../packages/plugins/triage/src/ui/window/mountedWindow';
import { createTriageEphemeralSharedScopeFixture } from '../../../../../packages/plugins/triage/src/ui/window/ephemeralSharedScope.test-support';
import { applyTriageEntryMutation } from '../../../../../packages/plugins/triage/src/composer/applyEntryMutation';
import { readTriageComposerAttachmentCatalog } from './triageNewSessionJourneyTestkit';

export type TriageComposerAttachmentJourneyInput = Readonly<{
    machineId: string;
    text: string;
    selection: NonNullable<ComposerSnapshotV1['selection']>;
    mention: Readonly<{ kind: string; ref: string; tokenText: string; start: number; end: number }>;
    unrelatedAttachment: ComposerAttachmentDraftV1;
    /** Actual authored executable modules substituted only for loading their bytes. */
    sourceSurfaces?: readonly Readonly<{ pluginId: string; renderSurface: RenderSurface }>[];
    executeAction(action: Readonly<{ pluginId: string; localId: string }>, input: unknown): Promise<unknown>;
}>;

export type TriageComposerAttachmentJourneyProbe = Readonly<{
    composerRef: ComposerRefV1;
    before: ComposerSnapshotV1;
    otherBefore: ComposerSnapshotV1;
    beforeDocument: Readonly<{ text: string; composerAttachments: readonly ComposerAttachmentDraftV1[] }>;
    reads: readonly unknown[];
    transactions: readonly unknown[];
    sourceHostRequests: readonly unknown[];
    readSnapshot(): ComposerSnapshotV1;
    readOtherSnapshot(): ComposerSnapshotV1;
    readDocument(): Readonly<{ text: string; composerAttachments: readonly ComposerAttachmentDraftV1[]; revision: number }>;
    pressAttach(title: string): Promise<void>;
    pressRemove(title: string): Promise<void>;
    pressViewDetails(title: string): Promise<unknown>;
    mountDestination(launchInput: unknown): Promise<void>;
    readDestinationCurrentRef(): ComposerRefV1 | null | undefined;
    hasDetailControl(role: 'button' | 'tab' | 'option', name: string): Promise<boolean>;
    pressDetailControl(role: 'button' | 'tab' | 'option', name: string): Promise<void>;
    readDetailText(): Promise<string>;
    retireComposer(): void;
    conflictAttach(input: Readonly<{ entryRef: TriageEntryRefV1; sourceInstance: TriageSourceInstanceRefV1;
        presentation: ComposerAttachmentAuthorPresentationV1; concurrentText: string }>):
        Promise<Readonly<{
            outcome: Readonly<{ kind: 'applied' }> | Readonly<{ kind: 'settled' }>
                | Readonly<{ kind: 'refused'; refusal: Readonly<{ code: string; maximum?: number }> }>;
            reads: number;
            applies: number;
        }>>;
    close(): Promise<void>;
}>;

function ExecutableTargetPresentation(props: Readonly<{
    render(presentation: PluginUiTargetedSurfacePresentation): ReactNode;
    reportCurrent(ref: ComposerRefV1 | null): void;
    children?: ReactNode;
}>) {
    const inherited = useOptionalPluginUiPresentationHost();
    const current = useComposer().current();
    useEffect(() => { props.reportCurrent(current?.ref ?? null); }, [current, props.reportCurrent]);
    const host = useMemo(() => {
        if (!inherited) throw new Error('Destination requires the semantic adapter presentation host');
        return { ...inherited, renderTargetedSurface: props.render };
    }, [inherited, props.render]);
    return createElement(PluginUiPresentationHostProviderInternal, { host }, props.children);
}

/** Register the real document for a cross-app dispatch test and expose its public host methods. */
export async function mountUiTriageDispatchComposer(input: Readonly<{
    machineId: string;
    text: string;
    selection: NonNullable<ComposerSnapshotV1['selection']>;
    publishSnapshot(ref: ComposerRefV1, snapshot: ComposerSnapshotV1): void;
}>) {
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Composer Account scope missing');
    await prepareSessionDraftPersistenceStorage();
    const { attachments, declaration } = await readTriageComposerAttachmentCatalog(input.machineId, scope.serverId);
    const composer = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', instanceId: randomUUID() } });
    composer.replaceDocument({ text: input.text, structuredInputMentions: [], composerAttachments: [] });
    let selection = input.selection;
    const readSnapshot = () => projectComposerDocumentSnapshot({ owner: composer, attachmentCatalog: { entriesById: attachments },
        presentation: { layout: 'wrap', focused: true, editable: true, submittable: true, submitting: false, running: false, selection } });
    const handlers = createComposerPresentationHostHandlers({ scope, mountedComposer: composer.ref,
        owner: { identity: declaration.identity, occurrenceId: declaration.occurrenceId, surfaceInstanceKey: 'dispatch-journey' },
        transactionApplier: createComposerPresentationTransactionApplier({ scope, composerAttachmentsById: attachments }),
        publishComposerSnapshot: event => input.publishSnapshot(composer.ref, event.snapshot) });
    const { readComposer, applyComposer, watchComposer, disposeHostResource } = handlers;
    if (!readComposer || !applyComposer || !watchComposer || !disposeHostResource) {
        handlers.dispose();
        throw new Error('Dispatch journey requires Composer reads, transactions and subscriptions');
    }
    const unregister = registerComposerPresentationTarget(composer.ref, {
        readScope: () => scope, readRevision: () => composer.read().revision, replace: () => composer.read().revision, readSnapshot,
        commitDocument: ({ expectedRevision, mutation }) => {
            const result = composer.apply(expectedRevision, mutation);
            if (result.status === 'applied' && mutation.selection) selection = mutation.selection;
            return result;
        },
        commitDocumentEmitsChange: true, createAttachmentInstanceId: randomUUID,
    });
    const unobserve = composer.observe(() => notifyComposerPresentationTargetChanged(composer.ref));
    const envelope = (method: PluginUiHostApiRequestEnvelopeV1['method'], payload: PluginUiHostApiRequestEnvelopeV1['payload']): PluginUiHostApiRequestEnvelopeV1 => ({
        version: 1, requestId: randomUUID(), method, payload,
        surface: { pluginId: PLUGIN_MANIFEST.id, contributionId: 'entry', surfaceId: 'dispatch-journey',
            placement: 'composerSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
    });
    const hostHandlers = {
        async readComposer({ ref, signal }) {
            return PluginUiReadComposerResultV1Schema.parse(await readComposer(envelope('readComposer', { ref }), { signal }));
        },
        async applyComposer({ ref, transaction, signal }) {
            return PluginUiApplyComposerResultV1Schema.parse(await applyComposer(envelope('applyComposer', { ref, transaction }), { signal }));
        },
        async watchComposer({ ref, signal }) {
            const subscriptionId = randomUUID();
            await watchComposer(envelope('watchComposer', { ref, subscriptionId }), { signal });
            return { async dispose() { await disposeHostResource(envelope('disposeHostResource', { subscriptionId })); } };
        },
    } satisfies Pick<PluginUiTestkitHostHandlers, 'readComposer' | 'applyComposer' | 'watchComposer'>;
    return {
        ref: composer.ref,
        readSnapshot,
        readStructuredInput: () => buildComposerSnapshotStructuredInputMetaOverrides(readSnapshot()).happierStructuredInputV1,
        hostHandlers,
        close() { handlers.dispose(); unobserve(); unregister(); },
    };
}

/** Actual admitted attachment, repository owners and SDK picker; only the renderer transport is replaced. */
export async function mountUiTriageComposerAttachmentJourney(
    input: TriageComposerAttachmentJourneyInput,
): Promise<TriageComposerAttachmentJourneyProbe> {
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Composer journey requires a restored Account');
    await prepareSessionDraftPersistenceStorage();
    const { attachments, declaration } = await readTriageComposerAttachmentCatalog(input.machineId, scope.serverId);
    const composer = createNewSessionComposerDocumentOwner({ scope,
        ref: { kind: 'newSession', instanceId: `addressed-${randomUUID()}` } });
    const other = createNewSessionComposerDocumentOwner({ scope,
        ref: { kind: 'newSession', instanceId: `focused-${randomUUID()}` } });
    composer.replaceDocument({ text: input.text, structuredInputMentions: [input.mention],
        composerAttachments: [input.unrelatedAttachment] });
    other.replaceDocument({ text: 'Other focused draft', structuredInputMentions: [], composerAttachments: [] });
    let addressedSelection = { ...input.selection };
    let otherSelection = { start: 1, end: 5 };
    const snapshot = (owner: typeof composer) => projectComposerDocumentSnapshot({ owner,
        attachmentCatalog: { entriesById: attachments }, presentation: { layout: 'wrap',
            focused: owner === other, editable: true, submittable: true, submitting: false, running: false,
            selection: owner === composer ? addressedSelection : otherSelection } });
    const cleanups: (() => void)[] = [];
    let picker: PluginUiTestkit | undefined;
    let destination: PluginUiTestkit | undefined;
    let destinationPhysical: PluginUiSemanticSurfaceMount | undefined;
    let destinationCurrent: ComposerRefV1 | null | undefined;
    let lastOpenInput: unknown;
    let unregisterAddressed = () => {};
    const destinationCleanups: (() => void)[] = [];
    const closeDestination = async () => {
        try { await destination?.dispose(); } finally {
            destination = undefined; destinationPhysical = undefined; destinationCurrent = undefined;
            for (const cleanup of destinationCleanups.splice(0).reverse()) cleanup();
        }
    };
    const close = async () => {
        try { await closeDestination(); await picker?.dispose(); } finally {
            picker = undefined;
            for (const cleanup of cleanups.splice(0).reverse()) cleanup();
        }
    };
    try {
        for (const owner of [composer, other]) {
            const unregister = registerComposerPresentationTarget(owner.ref, {
                readScope: () => scope, readRevision: () => owner.read().revision,
                replace: () => owner.read().revision, readSnapshot: () => snapshot(owner),
                commitDocument: ({ expectedRevision, mutation }) => {
                    const result = owner.apply(expectedRevision, mutation);
                    if (result.status === 'applied' && mutation.selection) {
                        if (owner === composer) addressedSelection = { ...mutation.selection };
                        else otherSelection = { ...mutation.selection };
                    }
                    return result;
                },
                commitDocumentEmitsChange: true,
                createAttachmentInstanceId: randomUUID,
            });
            if (owner === composer) unregisterAddressed = unregister;
            cleanups.push(unregister);
            cleanups.push(owner.observe(() => notifyComposerPresentationTargetChanged(owner.ref)));
        }
        const before = snapshot(composer);
        const beforeDocument = composer.read().document;
        const otherBefore = snapshot(other);
        const transactions: unknown[] = [];
        const reads: unknown[] = [];
        const sourceHostRequests: unknown[] = [];
        const handlers = createComposerPresentationHostHandlers({ scope, mountedComposer: composer.ref,
            owner: { identity: declaration.identity, occurrenceId: declaration.occurrenceId, surfaceInstanceKey: 'composer-journey' },
            transactionApplier: createComposerPresentationTransactionApplier({ scope, composerAttachmentsById: attachments }),
            publishComposerSnapshot: event => {
                picker?.emitComposerSnapshot(composer.ref, event.snapshot);
                destination?.emitComposerSnapshot(composer.ref, event.snapshot);
            },
        });
        cleanups.push(() => handlers.dispose());
        const { readComposer, applyComposer, watchComposer, disposeHostResource } = handlers;
        if (!readComposer || !applyComposer || !watchComposer || !disposeHostResource) {
            throw new Error('Composer journey requires document reads, transactions and subscriptions');
        }
        const envelope = (method: PluginUiHostApiRequestEnvelopeV1['method'], payload: PluginUiHostApiRequestEnvelopeV1['payload']): PluginUiHostApiRequestEnvelopeV1 => ({
            version: 1, requestId: randomUUID(), method, payload,
            surface: { pluginId: PLUGIN_MANIFEST.id, contributionId: 'entry', surfaceId: 'composer-journey',
                placement: 'composerSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
        });
        const composerKitHandlers = {
            async executeAction({ action, input: actionInput }) {
                const identity = normalizePluginUiMountedContributedActionReferenceV1({ callerPluginId: PLUGIN_MANIFEST.id, action });
                if (!identity) throw new Error('Composer journey requires a contributed Action reference');
                return PluginUiJsonValueV1Schema.parse(await input.executeAction(identity, actionInput));
            },
            async readComposer({ ref, signal }) {
                reads.push(ref);
                return PluginUiReadComposerResultV1Schema.parse(await readComposer(envelope('readComposer', { ref }), { signal }));
            },
            async applyComposer({ ref, transaction, signal }) {
                transactions.push({ ref, transaction });
                return PluginUiApplyComposerResultV1Schema.parse(await applyComposer(envelope('applyComposer', { ref, transaction }), { signal }));
            },
            async watchComposer({ ref, signal }) {
                const subscriptionId = randomUUID();
                await watchComposer(envelope('watchComposer', { ref, subscriptionId }), { signal });
                return { async dispose() { await disposeHostResource(envelope('disposeHostResource', { subscriptionId })); } };
            },
            publishCurrentUiContext() {},
        } satisfies PluginUiTestkitHostHandlers;
        const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
        await act(async () => {
            picker = await createPluginUiTestkit({ identity: { instanceId: randomUUID(), mountNonce: randomUUID() },
                authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                surface: renderSurface, surfaceContext: createSurfaceContextFixture(),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope }),
                launchInput: { v: 1, role: 'attachmentPicker', composer: composer.ref, attachmentLocalId: 'entry', instances: [] },
                handlers: {
                    ...composerKitHandlers,
                    openSurface: async ({ input: launchInput }) => { lastOpenInput = launchInput; },
                },
            });
        });
        const mountedPicker = picker;
        if (!mountedPicker) throw new Error('Picker not mounted');
        // The mounted list registers its client during the React commit.
        await act(async () => {
            await refreshTriageListWindow('view', mountedPicker.context.hostApi, ephemeralSharedScope);
        });
        const press = async (name: string) => {
            const target = await mountedPicker.findByRole('button', { name }).catch((error: unknown) => {
                throw new Error(`Mounted Composer could not find ${name}`, { cause: error });
            });
            if (target.state?.disabled || target.state?.busy) throw new Error('Mounted Composer control is not ready: ' + name);
            await act(async () => { await mountedPicker.press(target); });
        };
        const pressAttachment = async (name: string, expectedControl: string) => {
            await press(name);
            await mountedPicker.findByRole('button', { name: expectedControl }).catch((error: unknown) => {
                throw new Error('Composer did not show ' + expectedControl + ' after ' + name
                    + ' (' + reads.length + ' document reads, ' + transactions.length + ' transactions)', { cause: error });
            });
        };
        return {
            composerRef: composer.ref, before, beforeDocument, otherBefore, reads, transactions, sourceHostRequests,
            readSnapshot: () => snapshot(composer), readOtherSnapshot: () => snapshot(other),
            readDocument: () => ({ ...composer.read().document, revision: composer.read().revision }),
            pressAttach: title => pressAttachment(`Attach ${title}`, `Remove ${title}`),
            pressRemove: title => pressAttachment(`Remove ${title}`, `Attach ${title}`),
            async pressViewDetails(title) {
                lastOpenInput = undefined;
                await press(`View details ${title}`);
                if (lastOpenInput === undefined) throw new Error('Picker did not deliver a destination input');
                return lastOpenInput;
            },
            async mountDestination(launchInput) {
                await closeDestination();
                const account = await captureLazyActionAccountContext(scope.serverId);
                destinationCleanups.push(() => account.dispose());
                const cancellation = new AbortController();
                const retirement = account.accountLifetime.onRetire(() => cancellation.abort());
                destinationCleanups.push(() => { cancellation.abort(); retirement.dispose(); });
                const availability = readPluginAccountAvailability(scope);
                const selected = await availability.ensureCurrentAccountExecution(PLUGIN_MANIFEST.id);
                if (selected.kind !== 'available') throw new Error('Triage destination executable unavailable');
                const projection = availability.readAccountUiProjection();
                const projected = await readMountedAccountTargetedContributions({ pluginId: PLUGIN_MANIFEST.id,
                    origin: { ...scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
                    accountLifetime: account.accountLifetime, signal: cancellation.signal,
                    isCurrent: account.accountLifetime.isCurrent });
                const prepared = prepareTargetedSurfaceMounts(projected.targetedSurfaceMounts);
                const reportCurrent = (ref: ComposerRefV1 | null) => { destinationCurrent = ref; };
                type ChildRequest = NonNullable<ReturnType<typeof readTargetedPluginSurfaceReactMountRequest>>;
                const AuthoredSource = (props: Readonly<{ request: ChildRequest; context: RenderContext }>) => {
                    const mount = props.request.mount.mount;
                    const renderer = input.sourceSurfaces?.find(row => row.pluginId === mount.contributor.pluginId);
                    const boundary = useMemo(() => {
                        const source = availability.readCurrentAccountExecution(mount.contributor.pluginId);
                        if (source.kind !== 'available') throw new Error('Admitted source executable unavailable');
                        const controller = createBoundPluginSurfaceController({ facts: createTargetedPluginSurfaceBoundFacts({
                            request: props.request, accountLifetime: account.accountLifetime, platform: 'web', channel: 'internal',
                            serverId: scope.serverId, pluginUiProjection: projection,
                            interactionEnabled: true, daemonInteractionEnabled: false,
                        }) });
                        const surface = createSurfaceContextFixture({ ...props.context.surface,
                            mount: { kind: 'embedded', role: mount.role, presentation: mount.presentation },
                            targetedContributions: mount.contributorTargetedContributions });
                        const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface,
                            requestSurface: controller.surfaceContext, installedMethods: controller.installedMethods,
                            getInstalledMethods: () => controller.installedMethods,
                            getAdmissionMethods: () => controller.admissionMethods, isCurrent: controller.isCurrent,
                            handleRequest: async (request, options) => {
                                const observation: { request: typeof request; result?: unknown } = { request };
                                sourceHostRequests.push(observation);
                                const result = await controller.hostApi.handleRequest(request, options);
                                observation.result = result;
                                return result;
                            },
                        });
                        return { controller, adapter, surface, plugin: { id: source.manifest.id, version: source.manifest.version } };
                    }, [mount]);
                    useEffect(() => () => { boundary.adapter.dispose(); boundary.controller.dispose(); }, [boundary]);
                    if (!renderer) throw new Error(`Authored source module missing for ${mount.contributor.pluginId}`);
                    const raw = renderer.renderSurface({ ...props.context,
                        plugin: boundary.plugin,
                        surface: boundary.surface, hostApi: boundary.adapter.api, launchInput: props.request.input });
                    if (!isValidElement<{ ephemeralSharedScope?: typeof ephemeralSharedScope }>(raw)) {
                        throw new Error('Authored source has no provider entry');
                    }
                    return cloneElement(raw, { ephemeralSharedScope });
                };
                const page: RenderSurface = context => {
                    const raw = renderTriagePage(context);
                    if (!isValidElement<{ children?: ReactNode }>(raw)) throw new Error('Triage page has no provider entry');
                    const renderTarget = (presentation: PluginUiTargetedSurfacePresentation) => {
                        const request = readTargetedPluginSurfaceReactMountRequest({ presentation,
                            mounts: prepared, target: projected.targetedContributions.target });
                        return request === null ? presentation.fallback ?? null
                            : createElement(AuthoredSource, { key: request.instanceKey, request, context });
                    };
                    return cloneElement(raw, {}, createElement(ExecutableTargetPresentation,
                        { render: renderTarget, reportCurrent }, raw.props.children));
                };
                const semantic = createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true });
                await act(async () => {
                    destination = await createPluginUiTestkit({ identity: { instanceId: randomUUID(), mountNonce: randomUUID() },
                        authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, surface: page,
                        surfaceContext: createSurfaceContextFixture({ target: { kind: 'app' },
                            mount: { kind: 'destination', destination: TRIAGE_APP_PAGE_DESTINATION_V1, container: 'appPage' },
                            targetedContributions: projected.targetedContributions }),
                        ...(launchInput === undefined ? {} : { launchInput: PluginUiJsonValueV1Schema.parse(launchInput) }),
                        adapter: { async mount(options) { destinationPhysical = await semantic.mount(options); return destinationPhysical; } },
                        handlers: composerKitHandlers,
                    });
                });
            },
            readDestinationCurrentRef: () => destinationCurrent,
            async hasDetailControl(role, name) {
                if (!destination) throw new Error('Destination not mounted');
                return (await destination.queryByRole(role, { name })) !== undefined;
            },
            async pressDetailControl(role, name) {
                if (!destination) throw new Error('Destination not mounted');
                const target = await destination.findByRole(role, { name });
                await act(async () => { await destination!.press(target); });
            },
            async readDetailText() {
                if (!destinationPhysical) throw new Error('Destination not mounted');
                return (await destinationPhysical.snapshot()).texts?.map(row => row.content).join('\n') ?? '';
            },
            retireComposer: () => unregisterAddressed(),
            async conflictAttach({ concurrentText, ...mutation }) {
                const handle = await createComposersService(mountedPicker.context.hostApi, composer.ref).get(composer.ref);
                if (!handle) throw new Error('Exact Composer handle unavailable');
                const pendingRead = handle.read.bind(handle);
                const pendingApply = handle.apply.bind(handle);
                let mutationReads = 0;
                let mutationApplies = 0;
                const outcome = await applyTriageEntryMutation({ ...mutation, intent: 'attach', handle: {
                    ...handle,
                    read: async options => { mutationReads += 1; return await pendingRead(options); },
                    apply: async (transaction, options) => {
                        mutationApplies += 1;
                        composer.replaceDocument({ ...composer.read().document, text: concurrentText });
                        return await pendingApply(transaction, options);
                    },
                } });
                return { outcome, reads: mutationReads, applies: mutationApplies };
            },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
