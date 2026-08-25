import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    HappierField,
    HappierFormActions,
    HappierPressable,
    HappierScreen,
    HappierScrollArea,
    HappierSelect,
    HappierText,
    HappierTextField,
    HappierToggle,
    HappierValidationMessage,
    type HappierSelectOption,
} from '@happier-dev/plugin-ui/presentation';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import {
    HappierUiEnvironmentProvider,
    resolveHappierUiPresentationTheme,
    type HappierUiAccessibility,
    type HappierUiEnvironment,
} from '@happier-dev/plugin-ui/environment';

import {
    buildQualifiedPluginContributionKey,
    PluginDeclarativeComposerApplyEffectV1Schema,
    PluginContributionIdentityV1Schema,
    PluginJsonValueV2Schema,
    PluginSettingFieldSchemaV2Schema,
    type PluginContributionIdentityV1,
    type ComposerRefV1,
    type ComposerTransactionV1,
    type PluginJsonValueV2,
} from '@happier-dev/protocol';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import {
    PluginUiJsonValueV1Schema,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
    createDeclarativeTextResolver,
    readDeclarativeRecord as record,
    renderDeclarativeNode,
    type DeclarativeActionAffordance,
    type DeclarativeNodeRenderContext,
    type DeclarativeTextResolver,
} from '@/components/plugins/shared/declarativeNodes';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    type ScopedPluginSettingsDaemonTarget,
    type ScopedPluginSettingsField,
    type ScopedPluginSettingsRecordMutation,
    type ScopedPluginSettingsScope,
    resolveScopedPluginSettingsTarget,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    projectScopedPluginSettingsField,
    useScopedPluginSettingsProjection,
    type ScopedPluginSettingsFieldModel,
    type ScopedPluginSettingsProjectionState,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';
import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    resolveScopedPluginSettingsServerIdentity,
    scopedPluginAccountSecretSettingsAdapter,
    scopedPluginSettingsAdapter,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import type { BoundPluginSurfaceController } from './boundPluginSurfaceController';
import {
    DeclarativeCollectionList,
    type DeclarativeCollectionRowCommandAffordance,
    type DeclarativeCollectionRowCommandContext,
    type DeclarativeCollectionRowCommands,
} from './DeclarativeCollectionList';
import { resolvePluginUiIconName } from './iconToken/resolvePluginUiIconToken';
import {
    resolvePluginSurfaceDestinationDisabledReason,
    resolvePluginSurfaceDestinationIcon,
    resolvePluginSurfaceDestinationLabel,
} from './pluginSurfaceDestinations';
import { projectPluginUiTheme } from './pluginUiThemeProjection';
import { getPreferredLanguage, t } from '@/text';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';

/**
 * The declarative node vocabulary itself is rendered by the single owner in
 * `@/components/plugins/shared/declarativeNodes`. This module owns only what is
 * specific to a *mounted* surface: settings reads/writes, action dispatch,
 * currentness fencing and the editable field controls.
 */
export {
    DECLARATIVE_ACTION_VARIANT_COLORS,
    DECLARATIVE_STATE_PRESENTATION,
    DECLARATIVE_TONE_ACCESSIBILITY_LABELS,
    DECLARATIVE_TONE_TO_HAPPIER_TONE,
} from '@/components/plugins/shared/declarativeNodes';

type RecordValue = Readonly<Record<string, unknown>>;

function sameJsonValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
    }
    const leftRecord = record(left);
    const rightRecord = record(right);
    if (!leftRecord || !rightRecord) return false;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
            && sameJsonValue(leftRecord[key], rightRecord[key]));
}

type DeclarativeSettingScopeKind = 'account' | 'daemon';

type DeclarativeSettingBinding = Readonly<{
    id: string;
    scope: DeclarativeSettingScopeKind;
    secret: boolean;
}>;

type DeclarativeSettingsInventory = Readonly<{
    account: readonly ScopedPluginSettingsField[];
    accountDeclaredFields: readonly PluginProjectionEditableSettingField[];
    accountSecrets: readonly ScopedPluginSettingsField[];
    daemon: readonly ScopedPluginSettingsField[];
    daemonDeclaredFields: readonly PluginProjectionEditableSettingField[];
}>;

type DeclarativeSettingsFieldBuckets = {
    account: ScopedPluginSettingsField[];
    accountDeclaredFields: PluginProjectionEditableSettingField[];
    accountSecrets: ScopedPluginSettingsField[];
    daemon: ScopedPluginSettingsField[];
    daemonDeclaredFields: PluginProjectionEditableSettingField[];
};

/**
 * A nested declarative target has no B→C bridge in the initial composition
 * contract. Report that committed fallback through the B mount's existing
 * diagnostic path, never as a render-time side effect.
 */
function UnsupportedNestedTargetedSurfaceFallback(props: Readonly<{
    fallback: React.ReactNode;
    reportUnsupportedNestedTargetedSurface: () => void;
}>): React.ReactElement {
    React.useEffect(() => {
        props.reportUnsupportedNestedTargetedSurface();
    }, [props.reportUnsupportedNestedTargetedSurface]);
    return <>{props.fallback}</>;
}

const ACCOUNT_SETTINGS_SCOPE: ScopedPluginSettingsScope = Object.freeze({ kind: 'account' });
const DAEMON_SETTINGS_SCOPE: ScopedPluginSettingsScope = Object.freeze({ kind: 'daemon' });
const EMPTY_DECLARATIVE_SETTINGS_FIELDS: readonly ScopedPluginSettingsField[] = Object.freeze([]);

/**
 * A declarative field has an explicit model scope. The retired `pluginLocal`
 * descriptor is deliberately not inferred: it has no record owner in the
 * current host contract and therefore remains unavailable.
 */
function readDeclarativeSettingBinding(node: RecordValue): DeclarativeSettingBinding | null {
    const control = record(node.control);
    const setting = record(node.setting);
    const descriptor = record(setting?.descriptor);
    const id = typeof setting?.id === 'string' ? setting.id : null;
    const controlSettingId = typeof control?.settingId === 'string' ? control.settingId : null;
    const scope = descriptor?.scope;
    if (
        !id
        || id !== controlSettingId
        || (scope !== 'account' && scope !== 'daemon')
    ) {
        return null;
    }
    return {
        id,
        scope,
        secret: control?.kind === 'secret' || descriptor?.secret === true,
    };
}

function declarativeControlKind(
    control: RecordValue,
): PluginProjectionEditableSettingField['control'] | null {
    switch (control.kind) {
        case 'text': return 'text';
        case 'number': return 'number';
        case 'toggle': return 'switch';
        case 'select': return 'select';
        case 'secret': return 'password';
        default: return null;
    }
}

/**
 * Reattaches the normalized declarative field to the same declaration model
 * consumed by generic Settings. Protocol has already admitted control/schema
 * compatibility; this adapter only preserves those facts in the UI owner.
 */
function projectDeclarativeDeclaredField(
    node: RecordValue,
    binding: DeclarativeSettingBinding,
    localized: DeclarativeTextResolver,
): PluginProjectionEditableSettingField | null {
    const control = record(node.control);
    const setting = record(node.setting);
    const descriptor = record(setting?.descriptor);
    if (!control || !descriptor) return null;
    const projectedControl = declarativeControlKind(control);
    const schema = PluginSettingFieldSchemaV2Schema.safeParse(descriptor.schema);
    if (!projectedControl || !schema.success) return null;
    const schemaType = schema.data.type;
    const valueType: PluginProjectionEditableSettingField['valueType'] = (
        schemaType === 'string'
        || schemaType === 'boolean'
        || schemaType === 'number'
        || schemaType === 'integer'
        || schemaType === 'object'
        || schemaType === 'array'
        || schemaType === 'null'
    ) ? schemaType : projectedControl === 'switch'
        ? 'boolean'
        : projectedControl === 'number'
            ? 'number'
            : 'string';
    const parsedDefault = PluginJsonValueV2Schema.safeParse(descriptor.default);
    const title = localized(node.label);
    const subtitle = localized(node.description);
    return Object.freeze({
        key: binding.id,
        control: projectedControl,
        secretCustody: binding.secret ? binding.scope : null,
        valueType,
        valueSchema: schema.data,
        title,
        ...(subtitle ? { subtitle } : {}),
        redaction: binding.secret ? 'secret' : 'none',
        clearWhenEmpty: binding.secret ? 'omit' : 'persist',
        ...(projectedControl === 'switch' && typeof descriptor.default === 'boolean'
            ? { defaultBooleanValue: descriptor.default }
            : {}),
        ...(!binding.secret && parsedDefault.success
            ? { defaultValue: parsedDefault.data }
            : {}),
    });
}

function collectDeclarativeSettingsFields(
    nodeValue: unknown,
    fields: DeclarativeSettingsFieldBuckets,
    localized: DeclarativeTextResolver,
): void {
    const node = record(nodeValue);
    if (!node) return;
    if (node.kind === 'field') {
        const binding = readDeclarativeSettingBinding(node);
        const declaredField = binding
            ? projectDeclarativeDeclaredField(node, binding, localized)
            : null;
        if (binding && declaredField) {
            const bucket = binding.scope === 'account' && binding.secret
                ? 'accountSecrets'
                : binding.scope;
            const projectedField = projectScopedPluginSettingsField(declaredField);
            if (!fields[bucket].some((field) => field.key === binding.id)) {
                fields[bucket].push(projectedField);
            }
            if (!binding.secret) {
                const declaredBucket = binding.scope === 'account'
                    ? fields.accountDeclaredFields
                    : fields.daemonDeclaredFields;
                if (!declaredBucket.some((field) => field.key === binding.id)) {
                    declaredBucket.push(declaredField);
                }
            }
        }
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) collectDeclarativeSettingsFields(child, fields, localized);
    }
}

function collectDeclarativeSettingsInventory(
    root: RecordValue | null,
    localized: DeclarativeTextResolver,
): DeclarativeSettingsInventory {
    const fields: DeclarativeSettingsFieldBuckets = {
        account: [],
        accountDeclaredFields: [],
        accountSecrets: [],
        daemon: [],
        daemonDeclaredFields: [],
    };
    if (root) collectDeclarativeSettingsFields(root, fields, localized);
    return Object.freeze({
        account: Object.freeze(fields.account),
        accountDeclaredFields: Object.freeze(fields.accountDeclaredFields),
        accountSecrets: Object.freeze(fields.accountSecrets),
        daemon: Object.freeze(fields.daemon),
        daemonDeclaredFields: Object.freeze(fields.daemonDeclaredFields),
    });
}

const EMPTY_DECLARATIVE_SCOPED_SETTINGS_STATE: ScopedPluginSettingsProjectionState = Object.freeze({
    scopeKey: 'unavailable',
    values: Object.freeze({}),
    secretStates: Object.freeze({}),
    drafts: Object.freeze({}),
    revision: null,
    ready: false,
    settled: false,
    loading: false,
    writePending: false,
    error: null,
});

function readFieldValue(
    drafts: Readonly<Record<string, unknown>>,
    values: Readonly<Record<string, unknown>>,
    fieldId: string,
): unknown {
    return Object.prototype.hasOwnProperty.call(drafts, fieldId) ? drafts[fieldId] : values[fieldId];
}

type DeclarativeActionBinding = Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedActionId: string;
    input?: PluginUiJsonValueV1;
}>;

type DeclarativeComposerApplyBinding = Readonly<{
    transaction: ComposerTransactionV1;
}>;

function readActionBinding(node: RecordValue, generation: string | null): DeclarativeActionBinding | null {
    const action = record(node.action);
    const identity = PluginContributionIdentityV1Schema.safeParse(action?.identity);
    const input = Object.prototype.hasOwnProperty.call(node, 'input')
        ? PluginUiJsonValueV1Schema.safeParse(node.input)
        : null;
    if (
        !generation
        || !identity.success
        || (input !== null && !input.success)
        || action?.generation !== generation
        || action.qualifiedId !== buildQualifiedPluginContributionKey(identity.data)
    ) {
        return null;
    }
    return {
        identity: identity.data,
        qualifiedActionId: action.qualifiedId,
        ...(input === null ? {} : { input: input.data }),
    };
}

function readComposerApplyBinding(node: RecordValue): DeclarativeComposerApplyBinding | null {
    const parsed = PluginDeclarativeComposerApplyEffectV1Schema.safeParse(node.effect);
    if (!parsed.success) return null;
    return Object.freeze({
        transaction: Object.freeze({
            expectedRevision: parsed.data.expectedRevision,
            operations: parsed.data.operations,
        }),
    });
}

type DeclarativeQualifiedReference = Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
}>;

type DeclarativeCollectionRowCommand =
    | Readonly<{ kind: 'action'; action: DeclarativeQualifiedReference }>
    | Readonly<{ kind: 'openSurface'; destination: DeclarativeQualifiedReference }>;

type DeclarativeActionCatalogEntry = DeclarativeQualifiedReference & Readonly<{
    enabled: boolean;
    title: string;
    icon?: string;
}>;

type DeclarativeDestinationCatalogEntry = DeclarativeQualifiedReference;

type DeclarativeCollectionCommandCatalog = Readonly<{
    actions: ReadonlyMap<string, DeclarativeActionCatalogEntry>;
    destinations: ReadonlyMap<string, DeclarativeDestinationCatalogEntry>;
}>;

const EMPTY_DECLARATIVE_COLLECTION_COMMAND_CATALOG: DeclarativeCollectionCommandCatalog = Object.freeze({
    actions: new Map(),
    destinations: new Map(),
});

function readNonemptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reattaches a pre-normalized qualified target to this exact static model
 * generation. It deliberately does not accept a plugin-local author reference
 * or manufacture a qualified id from a label.
 */
function readDeclarativeQualifiedReference(input: Readonly<{
    value: unknown;
    pluginId: string;
    generation: string | null;
}>): DeclarativeQualifiedReference | null {
    const value = record(input.value);
    const identity = PluginContributionIdentityV1Schema.safeParse(value?.identity);
    const qualifiedId = readNonemptyString(value?.qualifiedId);
    if (
        !input.generation
        || !identity.success
        || identity.data.pluginId !== input.pluginId
        || value?.generation !== input.generation
        || qualifiedId !== buildQualifiedPluginContributionKey(identity.data)
    ) {
        return null;
    }
    return Object.freeze({ identity: identity.data, qualifiedId });
}

function readDeclarativeCollectionRowCommand(input: Readonly<{
    value: unknown;
    pluginId: string;
    generation: string | null;
}>): DeclarativeCollectionRowCommand | null {
    const command = record(input.value);
    if (command?.kind === 'action') {
        const action = readDeclarativeQualifiedReference({
            value: command.action,
            pluginId: input.pluginId,
            generation: input.generation,
        });
        return action ? Object.freeze({ kind: 'action', action }) : null;
    }
    if (command?.kind === 'openSurface') {
        const destination = readDeclarativeQualifiedReference({
            value: command.destination,
            pluginId: input.pluginId,
            generation: input.generation,
        });
        return destination ? Object.freeze({ kind: 'openSurface', destination }) : null;
    }
    return null;
}

/**
 * The CLI's static model remains the one catalog projection. This reader only
 * checks its exact qualified identities and poisons duplicate targets, so a
 * malformed projection cannot make a later entry become an alternative owner.
 */
function readDeclarativeCollectionCommandCatalog(input: Readonly<{
    model: RecordValue | null;
    pluginId: string;
    generation: string | null;
}>): DeclarativeCollectionCommandCatalog {
    if (!input.model || !input.generation) return EMPTY_DECLARATIVE_COLLECTION_COMMAND_CATALOG;
    const inventory = record(input.model.declarativeInventory);
    const actions = new Map<string, DeclarativeActionCatalogEntry>();
    const destinations = new Map<string, DeclarativeDestinationCatalogEntry>();
    const duplicatedActionIds = new Set<string>();
    const duplicatedDestinationIds = new Set<string>();

    for (const entryValue of Array.isArray(inventory?.actions) ? inventory.actions : []) {
        const entry = record(entryValue);
        const reference = readDeclarativeQualifiedReference({
            value: entry,
            pluginId: input.pluginId,
            generation: input.generation,
        });
        const title = readNonemptyString(entry?.title);
        if (!reference || !title) continue;
        if (actions.has(reference.qualifiedId) || duplicatedActionIds.has(reference.qualifiedId)) {
            actions.delete(reference.qualifiedId);
            duplicatedActionIds.add(reference.qualifiedId);
            continue;
        }
        const icon = readNonemptyString(entry?.icon);
        actions.set(reference.qualifiedId, Object.freeze({
            ...reference,
            enabled: entry?.enabled === true,
            title,
            ...(icon ? { icon } : {}),
        }));
    }

    for (const entryValue of Array.isArray(inventory?.destinations) ? inventory.destinations : []) {
        const reference = readDeclarativeQualifiedReference({
            value: entryValue,
            pluginId: input.pluginId,
            generation: input.generation,
        });
        if (!reference) continue;
        if (destinations.has(reference.qualifiedId) || duplicatedDestinationIds.has(reference.qualifiedId)) {
            destinations.delete(reference.qualifiedId);
            duplicatedDestinationIds.add(reference.qualifiedId);
            continue;
        }
        destinations.set(reference.qualifiedId, reference);
    }

    return Object.freeze({ actions, destinations });
}

function findCurrentDestinationPlacement(input: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    destination: PluginContributionIdentityV1;
}>): PluginUiSurfacePlacementProjection | null {
    const matches = Object.values(input.projection?.surfacePlacementsById ?? {}).filter((placement) => (
        placement.pluginId === input.destination.pluginId
        && placement.descriptorId === input.destination.localId
        && placement.binding.destination.pluginId === input.destination.pluginId
        && placement.binding.destination.localId === input.destination.localId
    ));
    return matches.length === 1 ? matches[0]! : null;
}

function createFixedCollectionRowActionInput(
    context: DeclarativeCollectionRowCommandContext,
): PluginUiJsonValueV1 {
    return Object.freeze({
        collection: Object.freeze({
            pluginId: context.collection.pluginId,
            collectionId: context.collection.collectionId,
        }),
        rowId: context.rowId,
        revision: context.revision,
    });
}

function rowCommandPendingKey(
    action: DeclarativeQualifiedReference,
    context: DeclarativeCollectionRowCommandContext,
): string {
    return JSON.stringify([
        action.qualifiedId,
        context.collection.pluginId,
        context.collection.collectionId,
        context.rowId,
        context.revision,
    ]);
}

/**
 * The row renderer needs a narrow invalidation fact for pending Actions, while
 * the mounted surface remains the sole action/pending owner. This uses the
 * same admitted command parser and catalog as command resolution; it does not
 * retain rows or create a second pending-state registry.
 */
function readCollectionRowCommandPendingState(input: Readonly<{
    node: RecordValue;
    context: DeclarativeCollectionRowCommandContext;
    pluginId: string;
    generation: string | null;
    actions: ReadonlyMap<string, DeclarativeActionCatalogEntry>;
    pendingActions: ReadonlySet<string>;
}>): string | null {
    const commandValues = [
        input.node.primaryCommand,
        ...(Array.isArray(input.node.secondaryCommands) ? input.node.secondaryCommands : []),
    ];
    const pendingActionIds: string[] = [];
    for (const commandValue of commandValues) {
        const command = readDeclarativeCollectionRowCommand({
            value: commandValue,
            pluginId: input.pluginId,
            generation: input.generation,
        });
        if (command?.kind !== 'action') continue;
        const action = input.actions.get(command.action.qualifiedId);
        if (action && input.pendingActions.has(rowCommandPendingKey(action, input.context))) {
            pendingActionIds.push(action.qualifiedId);
        }
    }
    return pendingActionIds.length > 0 ? pendingActionIds.join('\u0000') : null;
}

export function DeclarativePluginSurface(props: Readonly<{
    /** Complete mounted environment shared by every declarative root family. */
    environment?: HappierUiEnvironment;
    pluginId: string;
    model: unknown;
    machineId?: string | null;
    serverId?: string | null;
    /** Settings routes may supply the exact Administration target; null is fail-closed. */
    daemonSettingsTarget?: ScopedPluginSettingsDaemonTarget | null;
    /** Portable selected-server identity for Account perActiveServer bindings. */
    perActiveServerIdentityId?: string | null;
    isDaemonSettingsTargetCurrent?: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Settings routes can keep Account and daemon field availability independent. */
    settingsScopesEnabled?: Readonly<{ account: boolean; daemon: boolean }>;
    /**
     * Account-local presentation admission. This controls the shared surface
     * boundary and therefore needs the mounted Account lifetime, not daemon
     * reachability: Account settings, Data and local navigation can remain
     * usable while the selected daemon reconnects.
     */
    interactionEnabled: boolean;
    /** Outer physical mount's retained-pane eligibility, independent of availability. */
    focusEligible?: boolean;
    /**
     * Admission for daemon-owned effects only. The controller is still the
     * factual handler owner; this prevents the declarative renderer from
     * treating a locally interactive Account surface as an action-capable one.
     */
    daemonInteractionEnabled: boolean;
    /** The mounted controller's canonical host facade, never a local dispatcher. */
    dispatchAction: BoundPluginSurfaceController['dispatchAction'];
    /** Its factual installation result, after capability/origin/currentness admission. */
    actionAvailable: boolean;
    /** Host-private Composer scope supplied only by an exact Composer mount. */
    composerRef?: ComposerRefV1;
    /** The mounted controller's canonical Composer mutation facade. */
    applyComposer?: BoundPluginSurfaceController['applyComposer'];
    /** Its factual installation result; absent Composer scope remains inert. */
    composerApplyAvailable?: boolean;
    /** Current projection consumed only for destination presentation/availability. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    /** The mounted host's resolved policy context, never a local policy engine. */
    policyContext?: PluginUiPolicyEvaluationContext;
    /** The mounted controller's canonical destination facade. */
    openSurface: BoundPluginSurfaceController['openSurface'];
    /** Its factual installation result; local navigation may remain available offline. */
    openSurfaceAvailable: boolean;
    authorityGeneration: number;
    /** Opaque shared lifetime fencing mounted Account and daemon Settings UI state. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** The host-created Data client for this same captured Account lifetime. */
    dataClient?: PluginUiDataClient | null;
    /**
     * The dynamic document adapter keeps its last-known-good model mounted;
     * this only supplies bounded feedback and a canonical Resource retry.
     */
    documentSourcePresentation?: Readonly<{
        presentation: PluginSurfaceStatePresentation;
        retry: () => void;
    }> | null;
    /**
     * The one live target-local presentation bridge. A destination parent
     * supplies it; an embedded child intentionally does not, so initial
     * composition remains one level deep.
     */
    /**
     * The physical target bridge receives renderer-owned fallback output so it
     * can preserve it when an exact B mount later becomes unavailable.
     */
    renderTargetedSurface?: (node: RecordValue, fallback: React.ReactNode) => React.ReactNode;
    /** B's deliberately unsupported nested target reports through B's mount. */
    reportUnsupportedNestedTargetedSurface?: () => void;
    /** `content` stays inside its parent's existing document scroll owner. */
    embeddedPresentation?: 'content' | 'fill';
    /** Resolved host contrast fact; this renderer never owns preference policy. */
    contrast?: HappierUiAccessibility['contrast'];
}>) {
    const { theme } = useUnistyles();
    const activeServer = useActiveServerSnapshot();
    const projectedPresentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const presentationTheme = React.useMemo(
        () => resolveHappierUiPresentationTheme(projectedPresentationTheme, props.contrast ?? 'normal'),
        [projectedPresentationTheme, props.contrast],
    );
    // A mounted document is live UI, so its declared keys resolve against the
    // surface environment's admitted bundle for the current locale. The author's
    // fallback still answers every key that bundle does not define.
    const localized = React.useMemo(
        () => createDeclarativeTextResolver(props.environment?.localization.translate),
        [props.environment],
    );
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({
            projection: props.pluginUiProjection,
            locale: pluginLocale,
        }),
        [pluginLocale, props.pluginUiProjection],
    );
    const model = record(props.model);
    const identity = record(model?.identity);
    const root = record(model?.root);
    const generation = typeof identity?.generation === 'string' ? identity.generation : null;
    const qualifiedId = typeof identity?.qualifiedId === 'string'
        ? identity.qualifiedId
        : props.pluginId;
    const visible = model?.visible === true && identity?.pluginId === props.pluginId && generation !== null;
    const collectionCommandCatalog = React.useMemo(() => readDeclarativeCollectionCommandCatalog({
        model,
        pluginId: props.pluginId,
        generation,
    }), [generation, model, props.pluginId]);
    const [pendingActions, setPendingActions] = React.useState<ReadonlySet<string>>(new Set());
    const settingsInventory = React.useMemo(
        () => collectDeclarativeSettingsInventory(root, localized),
        [localized, root],
    );
    const settingsSourceLifetimeIdentity = `${qualifiedId}:${generation ?? 'unavailable'}:${props.authorityGeneration}`;
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const daemonServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(props.serverId),
        [props.serverId],
    );
    const accountTarget = React.useMemo(() => resolveScopedPluginSettingsTarget({
        scope: ACCOUNT_SETTINGS_SCOPE,
        serverIdentityId: accountServerIdentityId,
    }), [accountServerIdentityId]);
    const originDaemonTarget = React.useMemo(() => resolveScopedPluginSettingsTarget({
        scope: DAEMON_SETTINGS_SCOPE,
        machineId: props.machineId,
        serverId: props.serverId,
        serverIdentityId: daemonServerIdentityId,
    }), [daemonServerIdentityId, props.machineId, props.serverId]);
    // Generic Settings routes explicitly pass null when Administration has no
    // executable exact target. That must not fall back to an app/session origin.
    const daemonTarget = props.daemonSettingsTarget === undefined
        ? originDaemonTarget
        : props.daemonSettingsTarget;
    // The target selection belongs to Administration/UI. Account record
    // custody remains active-server-only; an Account per-server binding reads
    // this separate portable identity when a declaration supports one.
    const perActiveServerIdentityId = props.perActiveServerIdentityId === undefined
        ? daemonTarget?.serverIdentityId ?? null
        : props.perActiveServerIdentityId;
    const accountSettingsEnabled = props.settingsScopesEnabled?.account ?? props.interactionEnabled;
    const daemonSettingsEnabled = props.settingsScopesEnabled?.daemon ?? props.daemonInteractionEnabled;
    const accountSettings = useScopedPluginSettingsProjection({
        pluginId: props.pluginId,
        scope: ACCOUNT_SETTINGS_SCOPE,
        target: accountTarget,
        accountLifetime: props.accountLifetime ?? null,
        fields: settingsInventory.account,
        declaredFields: settingsInventory.accountDeclaredFields,
        sourceLifetimeIdentity: settingsSourceLifetimeIdentity,
        perActiveServerIdentityId,
        enabled: visible && accountSettingsEnabled,
        adapter: scopedPluginSettingsAdapter,
    });
    const accountSecretSettings = useScopedPluginSettingsProjection({
        pluginId: props.pluginId,
        scope: ACCOUNT_SETTINGS_SCOPE,
        target: accountTarget,
        accountLifetime: props.accountLifetime ?? null,
        fields: settingsInventory.accountSecrets,
        sourceLifetimeIdentity: settingsSourceLifetimeIdentity,
        perActiveServerIdentityId: null,
        enabled: visible && accountSettingsEnabled,
        adapter: scopedPluginAccountSecretSettingsAdapter,
    });
    const daemonSettings = useScopedPluginSettingsProjection({
        pluginId: props.pluginId,
        scope: DAEMON_SETTINGS_SCOPE,
        target: daemonTarget,
        accountLifetime: props.accountLifetime ?? null,
        fields: settingsInventory.daemon,
        declaredFields: settingsInventory.daemonDeclaredFields,
        sourceLifetimeIdentity: settingsSourceLifetimeIdentity,
        perActiveServerIdentityId,
        enabled: visible && daemonSettingsEnabled,
        adapter: scopedPluginSettingsAdapter,
    });
    const settingsError = accountSettings.state.error
        ?? accountSecretSettings.state.error
        ?? daemonSettings.state.error;
    const accountFieldModelsByKey = React.useMemo(
        () => new Map(accountSettings.fieldModels.map((fieldModel) => [fieldModel.field.key, fieldModel])),
        [accountSettings.fieldModels],
    );
    const daemonFieldModelsByKey = React.useMemo(
        () => new Map(daemonSettings.fieldModels.map((fieldModel) => [fieldModel.field.key, fieldModel])),
        [daemonSettings.fieldModels],
    );
    const scopeSequenceRef = React.useRef(0);
    const pendingActionIdsRef = React.useRef(new Set<string>());
    const minimumTouchTarget = resolveMinimumInteractiveTargetSize(Platform.OS);
    const composerScopeKey = props.composerRef === undefined
        ? 'unavailable'
        : composerRefV1Key(props.composerRef);

    React.useEffect(() => {
        scopeSequenceRef.current += 1;
        pendingActionIdsRef.current.clear();
        setPendingActions(new Set());
    }, [
        generation,
        props.authorityGeneration,
        composerScopeKey,
        props.applyComposer,
        props.composerApplyAvailable,
        props.daemonInteractionEnabled,
        props.interactionEnabled,
        props.machineId,
        props.pluginId,
        props.serverId,
        visible,
    ]);

    const runAction = React.useCallback((
        binding: DeclarativeActionBinding,
        enabled: boolean,
        pendingKey = binding.qualifiedActionId,
    ) => {
        if (
            !props.daemonInteractionEnabled
            || !enabled
            || !props.actionAvailable
            || pendingActionIdsRef.current.has(pendingKey)
        ) {
            return;
        }
        const scopeSequence = scopeSequenceRef.current;
        pendingActionIdsRef.current.add(pendingKey);
        setPendingActions((current) => new Set(current).add(pendingKey));
        // Declarative nodes are a host renderer, not an authority boundary. The
        // bound controller stamps caller/origin/currentness and invokes the one
        // canonical action dispatcher through its mounted host facade.
        void props.dispatchAction(binding.identity, binding.input).finally(() => {
            if (scopeSequenceRef.current !== scopeSequence) return;
            pendingActionIdsRef.current.delete(pendingKey);
            setPendingActions((current) => {
                const next = new Set(current);
                next.delete(pendingKey);
                return next;
            });
        });
    }, [props.actionAvailable, props.daemonInteractionEnabled, props.dispatchAction]);

    const runComposerApply = React.useCallback((
        binding: DeclarativeComposerApplyBinding,
        enabled: boolean,
        pendingKey: string,
    ) => {
        const composerRef = props.composerRef;
        const applyComposer = props.applyComposer;
        if (
            !props.interactionEnabled
            || !enabled
            || !props.composerApplyAvailable
            || !composerRef
            || !applyComposer
            || pendingActionIdsRef.current.has(pendingKey)
        ) {
            return;
        }
        const scopeSequence = scopeSequenceRef.current;
        pendingActionIdsRef.current.add(pendingKey);
        setPendingActions((current) => new Set(current).add(pendingKey));
        // The declarative effect has no authored Composer target. The mounted
        // facade supplies the exact host-owned ref and forwards the same
        // canonical CAS transaction as every SDK renderer.
        void applyComposer(composerRef, binding.transaction).finally(() => {
            if (scopeSequenceRef.current !== scopeSequence) return;
            pendingActionIdsRef.current.delete(pendingKey);
            setPendingActions((current) => {
                const next = new Set(current);
                next.delete(pendingKey);
                return next;
            });
        });
    }, [props.applyComposer, props.composerApplyAvailable, props.composerRef, props.interactionEnabled]);

    /**
     * The mounted surface's action affordance. A node whose binding does not
     * agree with the current generation stays visible but inert, so a stale
     * projection cannot dispatch.
     */
    const resolveAction = React.useCallback((node: RecordValue): DeclarativeActionAffordance => {
        const composerApply = readComposerApplyBinding(node);
        if (composerApply !== null) {
            const key = `composerApply:${typeof node.path === 'string' ? node.path : 'invalid'}`;
            const busy = pendingActions.has(key);
            const disabled = node.enabled !== true
                || !props.interactionEnabled
                || !props.composerApplyAvailable
                || !props.composerRef
                || !props.applyComposer
                || busy;
            return {
                key,
                disabled,
                busy,
                onPress: () => runComposerApply(composerApply, true, key),
            };
        }
        const binding = readActionBinding(node, generation);
        const key = binding?.qualifiedActionId ?? `invalid:${String(node.path)}`;
        const busy = binding !== null && pendingActions.has(binding.qualifiedActionId);
        const disabled = node.enabled !== true
            || !props.daemonInteractionEnabled
            || !props.actionAvailable
            || !binding
            || busy;
        return {
            key,
            disabled,
            busy,
            ...(binding ? { onPress: () => runAction(binding, true) } : {}),
        };
    }, [
        generation,
        pendingActions,
        props.actionAvailable,
        props.applyComposer,
        props.composerApplyAvailable,
        props.composerRef,
        props.daemonInteractionEnabled,
        props.interactionEnabled,
        runComposerApply,
        runAction,
    ]);

    /**
     * Row commands are projected by the neutral document normalizer, then
     * rebound here to the current Action/destination catalogs. Data contributes
     * only its fixed row context; the list supplies its static normalized node.
     */
    const resolveCollectionRowCommands = React.useCallback((
        context: DeclarativeCollectionRowCommandContext,
        node: RecordValue,
    ): DeclarativeCollectionRowCommands | null => {
        const resolveCommand = (
            commandValue: unknown,
            commandIndex: number,
        ): DeclarativeCollectionRowCommandAffordance | null => {
            const command = readDeclarativeCollectionRowCommand({
                value: commandValue,
                pluginId: props.pluginId,
                generation,
            });
            if (!command) return null;

            if (command.kind === 'action') {
                const action = collectionCommandCatalog.actions.get(command.action.qualifiedId);
                if (!action) return null;
                const pendingKey = rowCommandPendingKey(action, context);
                const busy = pendingActionIdsRef.current.has(pendingKey);
                const disabled = !action.enabled
                    || !props.daemonInteractionEnabled
                    || !props.actionAvailable
                    || busy;
                const binding: DeclarativeActionBinding = Object.freeze({
                    identity: action.identity,
                    qualifiedActionId: action.qualifiedId,
                    input: createFixedCollectionRowActionInput(context),
                });
                return Object.freeze({
                    id: `action:${action.qualifiedId}:${commandIndex}`,
                    label: action.title,
                    ...(action.icon ? {
                        icon: <Icon name={resolvePluginUiIconName(action.icon, props.environment?.direction)} size={ICON_SIZE.sm} />,
                    } : {}),
                    disabled,
                    busy,
                    onPress: () => runAction(binding, action.enabled, pendingKey),
                });
            }

            const destination = collectionCommandCatalog.destinations.get(command.destination.qualifiedId);
            if (!destination) return null;
            const placement = findCurrentDestinationPlacement({
                projection: props.pluginUiProjection,
                destination: destination.identity,
            });
            if (!placement) return null;
            const disabled = !props.openSurfaceAvailable
                || resolvePluginSurfaceDestinationDisabledReason(placement, props.policyContext) !== null;
            return Object.freeze({
                id: `destination:${destination.qualifiedId}:${commandIndex}`,
                label: resolvePluginSurfaceDestinationLabel(placement, localizePluginText),
                icon: <Icon name={resolvePluginSurfaceDestinationIcon(placement, props.environment?.direction)} size={ICON_SIZE.sm} />,
                disabled,
                onPress: () => { void props.openSurface(destination.identity); },
            });
        };

        const primary = node.primaryCommand === undefined
            ? undefined
            : resolveCommand(node.primaryCommand, 0) ?? undefined;
        const secondary = Array.isArray(node.secondaryCommands)
            ? Object.freeze(node.secondaryCommands.flatMap((command, index) => {
                const affordance = resolveCommand(command, index + 1);
                return affordance ? [affordance] : [];
            }))
            : Object.freeze([]);
        return primary || secondary.length > 0
            ? Object.freeze({ ...(primary ? { primary } : {}), secondary })
            : null;
    }, [
        collectionCommandCatalog.actions,
        collectionCommandCatalog.destinations,
        generation,
        props.actionAvailable,
        props.daemonInteractionEnabled,
        props.openSurface,
        props.openSurfaceAvailable,
        props.pluginId,
        props.pluginUiProjection,
        props.policyContext,
        localizePluginText,
        runAction,
    ]);
    const getCollectionRowCommandState = React.useCallback((
        context: DeclarativeCollectionRowCommandContext,
        node: RecordValue,
    ): string | null => readCollectionRowCommandPendingState({
        node,
        context,
        pluginId: props.pluginId,
        generation,
        actions: collectionCommandCatalog.actions,
        pendingActions,
    }), [collectionCommandCatalog.actions, generation, pendingActions, props.pluginId]);

    const renderField = (node: RecordValue): React.ReactNode => {
        const nodePath = typeof node.path === 'string' ? node.path : 'field';
        const fieldTestID = `plugin-declarative-field:${nodePath}`;
        const control = record(node.control);
        const setting = record(node.setting);
        const settingId = typeof setting?.id === 'string' ? setting.id : null;
        const controlSettingId = typeof control?.settingId === 'string' ? control.settingId : null;
        if (!settingId || settingId !== controlSettingId) return null;

        const fieldId = settingId;
        const binding = readDeclarativeSettingBinding(node);
        const scopedSettings = binding?.scope === 'account'
            ? binding.secret
                ? accountSecretSettings
                : accountSettings
            : binding?.scope === 'daemon'
                ? daemonSettings
                : null;
        const fieldModel: ScopedPluginSettingsFieldModel | null = !binding?.secret
            ? binding?.scope === 'account'
                ? accountFieldModelsByKey.get(fieldId) ?? null
                : binding?.scope === 'daemon'
                    ? daemonFieldModelsByKey.get(fieldId) ?? null
                    : null
            : null;
        const writeCurrentness = binding?.scope === 'daemon'
            && daemonTarget?.kind === 'daemon'
            && props.isDaemonSettingsTargetCurrent
            ? () => props.isDaemonSettingsTargetCurrent!(daemonTarget)
            : undefined;
        const commitSetting = (mutation: ScopedPluginSettingsRecordMutation) => {
            void scopedSettings?.commit({
                fieldId,
                mutation,
                ...(writeCurrentness ? { isCurrent: writeCurrentness } : {}),
            });
        };
        const settingsState = scopedSettings?.state ?? EMPTY_DECLARATIVE_SCOPED_SETTINGS_STATE;
        const label = localized(node.label);
        const description = localized(node.description) || undefined;
        const value = binding?.secret
            ? readFieldValue(settingsState.drafts, settingsState.values, fieldId)
            : fieldModel?.draft;
        const scopeEnabled = binding?.scope === 'account'
            ? accountSettingsEnabled
            : binding?.scope === 'daemon'
                ? daemonSettingsEnabled
                : false;
        const disabled = !scopeEnabled
            || !binding
            || !settingsState.ready
            || settingsState.writePending
            || (!binding.secret && fieldModel === null);
        const fieldProps = {
            label,
            ...(description ? { description } : {}),
            disabled,
            theme: presentationTheme,
            testID: `${fieldTestID}:container`,
        } as const;

        if (control?.kind === 'toggle') {
            return (
                <HappierField key={nodePath} {...fieldProps}>
                    <HappierToggle
                        testID={fieldTestID}
                        label={label}
                        value={value === true}
                        disabled={disabled}
                        minimumTouchTarget={minimumTouchTarget}
                        theme={presentationTheme}
                        onChange={(next) => {
                            void fieldModel?.commit({
                                draft: next,
                                ...(writeCurrentness ? { isCurrent: writeCurrentness } : {}),
                            });
                        }}
                    />
                </HappierField>
            );
        }

        if (control?.kind === 'select') {
            const options = (Array.isArray(control.options) ? control.options : [])
                .flatMap((optionValue, index): HappierSelectOption<PluginJsonValueV2>[] => {
                    const option = record(optionValue);
                    const parsedValue = PluginJsonValueV2Schema.safeParse(option?.value);
                    if (!option || !parsedValue.success) return [];
                    return [{
                        value: parsedValue.data,
                        label: localized(option.label),
                        testID: `${fieldTestID}:option:${index}`,
                    }];
                });
            const parsedValue = PluginJsonValueV2Schema.safeParse(value);

            return (
                <HappierField key={nodePath} {...fieldProps}>
                    <HappierSelect<PluginJsonValueV2>
                        testID={fieldTestID}
                        label={label}
                        options={options}
                        value={parsedValue.success ? parsedValue.data : undefined}
                        disabled={disabled}
                        minimumTouchTarget={minimumTouchTarget}
                        theme={presentationTheme}
                        isEqual={sameJsonValue}
                        keyForOption={(_option, index) => `${nodePath}:${index}`}
                        onChange={(next) => {
                            const nextValue = next as PluginJsonValueV2;
                            void fieldModel?.commit({
                                draft: nextValue,
                                ...(writeCurrentness ? { isCurrent: writeCurrentness } : {}),
                            });
                        }}
                    />
                </HappierField>
            );
        }

        if (control?.kind !== 'text' && control?.kind !== 'number' && control?.kind !== 'secret') {
            return null;
        }

        const hasExplicitDraft = binding?.secret === true
            ? Object.prototype.hasOwnProperty.call(settingsState.drafts, fieldId)
            : fieldModel?.dirty === true;
        const draftValue = binding?.secret === true
            ? hasExplicitDraft ? settingsState.drafts[fieldId] : ''
            : fieldModel?.draft ?? '';
        const numberValue = control.kind === 'number'
            && typeof draftValue === 'string'
            && draftValue.trim().length > 0
            ? Number(draftValue)
            : null;
        const isAccountSecret = binding?.scope === 'account' && binding.secret;
        const canSave = !disabled
            && (binding?.secret === true ? (!isAccountSecret || hasExplicitDraft) : fieldModel?.dirty === true)
            && (control.kind !== 'number' || (numberValue !== null && Number.isFinite(numberValue)));
        const canDelete = isAccountSecret
            && settingsState.secretStates[fieldId] === 'configured'
            && !disabled;
        const committedValue = control.kind === 'number'
            ? numberValue
            : binding?.secret === true
                ? hasExplicitDraft
                    ? settingsState.drafts[fieldId]
                    : readFieldValue(settingsState.drafts, settingsState.values, fieldId) ?? ''
                : fieldModel?.draft ?? '';
        return (
            <HappierField key={nodePath} {...fieldProps}>
                <HappierTextField
                    testID={fieldTestID}
                    label={label}
                    value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                    disabled={disabled}
                    keyboardType={control.kind === 'number' ? 'numeric' : 'default'}
                    secure={control.kind === 'secret'}
                    minimumTouchTarget={minimumTouchTarget}
                    theme={presentationTheme}
                    onChangeText={(next) => {
                        if (binding?.secret === true) {
                            scopedSettings?.setDraft(fieldId, next);
                        } else {
                            fieldModel?.setDraft(next);
                        }
                    }}
                />
                <HappierFormActions testID={`${fieldTestID}:actions`}>
                    {canDelete ? (
                        <HappierPressable
                            testID={`plugin-declarative-field-delete:${nodePath}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.delete')}
                            disabled={disabled}
                            onPress={() => commitSetting({ kind: 'delete' })}
                            style={(state) => ({
                                minWidth: minimumTouchTarget,
                                minHeight: minimumTouchTarget,
                                justifyContent: 'center',
                                alignItems: 'center',
                                paddingHorizontal: presentationTheme.spacing.medium,
                                borderRadius: presentationTheme.radii.control,
                                backgroundColor: presentationTheme.colors.accent,
                                opacity: state.disabled ? 0.5 : state.pressed ? 0.8 : 1,
                            })}
                        >
                            <HappierText style={{ color: presentationTheme.colors.onAccent }}>
                                {t('common.delete')}
                            </HappierText>
                        </HappierPressable>
                    ) : null}
                    <HappierPressable
                        testID={`plugin-declarative-field-save:${nodePath}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.save')}
                        disabled={!canSave}
                        onPress={() => {
                            if (
                                control.kind === 'number'
                                && (committedValue === null || !Number.isFinite(committedValue))
                            ) {
                                return;
                            }
                            const parsedCommittedValue = PluginJsonValueV2Schema.safeParse(committedValue);
                            if (!parsedCommittedValue.success) return;
                            if (binding?.secret === true) {
                                commitSetting({ kind: 'set', value: parsedCommittedValue.data });
                            } else {
                                void fieldModel?.commit({
                                    ...(writeCurrentness ? { isCurrent: writeCurrentness } : {}),
                                });
                            }
                        }}
                        style={(state) => ({
                            minWidth: minimumTouchTarget,
                            minHeight: minimumTouchTarget,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingHorizontal: presentationTheme.spacing.medium,
                            borderRadius: presentationTheme.radii.control,
                            backgroundColor: presentationTheme.colors.accent,
                            opacity: state.disabled ? 0.5 : state.pressed ? 0.8 : 1,
                        })}
                    >
                        <HappierText style={{ color: presentationTheme.colors.onAccent }}>
                            {t('common.save')}
                        </HappierText>
                    </HappierPressable>
                </HappierFormActions>
            </HappierField>
        );
    };

    const rootCollectionListOwnsScrollViewport = props.embeddedPresentation !== 'content'
        && root?.kind === 'collectionList';
    const renderCollectionList = (node: RecordValue): React.ReactNode => {
        const accessibilityLabel = localized(node.label);
        return (
            <DeclarativeCollectionList
                key={typeof node.path === 'string' ? node.path : 'root'}
                pluginId={props.pluginId}
                modelGeneration={generation ?? ''}
                node={node}
                accountLifetime={props.accountLifetime ?? null}
                dataClient={props.dataClient ?? null}
                presentationTheme={presentationTheme}
                minimumTouchTarget={minimumTouchTarget}
                {...(accessibilityLabel ? { accessibilityLabel } : {})}
                ownsScrollViewport={rootCollectionListOwnsScrollViewport && node === root}
                resolveRowCommands={resolveCollectionRowCommands}
                getRowCommandState={getCollectionRowCommandState}
            />
        );
    };

    let renderContext!: DeclarativeNodeRenderContext;
    const renderTargetedSurface = (node: RecordValue): React.ReactNode => {
        const fallback = record(node.fallback);
        const fallbackNode = fallback
            ? renderDeclarativeNode(fallback, { ...renderContext, renderTargetedSurface: undefined })
            : null;
        const mounted = props.renderTargetedSurface?.(node, fallbackNode);
        if (mounted !== null && mounted !== undefined) {
            return mounted;
        }
        // An embedded child, unavailable exact mount, or unsupported renderer
        // has no active target bridge. Its source still gets the declared state
        // fallback without creating an ancestry registry or resolving another
        // current contributor from immutable document bytes.
        if (props.reportUnsupportedNestedTargetedSurface) {
            return (
                <UnsupportedNestedTargetedSurfaceFallback
                    fallback={fallbackNode}
                    reportUnsupportedNestedTargetedSurface={props.reportUnsupportedNestedTargetedSurface}
                />
            );
        }
        return fallbackNode;
    };
    renderContext = {
        colors: theme.colors,
        presentationTheme,
        localize: localized,
        direction: props.environment?.direction,
        contrast: props.contrast,
        minimumTouchTarget,
        resolveAction,
        renderField,
        renderCollectionList,
        renderTargetedSurface,
    };
    const renderNode = (nodeValue: unknown) => renderDeclarativeNode(nodeValue, renderContext);

    const rootTargetedSurface = root?.kind === 'targetedSurface'
        ? record(root.surface)
        : null;
    const rootOwnsFlexViewport = rootCollectionListOwnsScrollViewport
        || rootTargetedSurface?.presentation === 'fill';
    const rootOwnsScroll = props.embeddedPresentation !== 'content'
        && rootTargetedSurface?.presentation !== 'fill'
        && !rootCollectionListOwnsScrollViewport;

    if (!visible || !root) return null;
    const documentSourceNotice = props.documentSourcePresentation?.presentation.contentNotice ?? null;
    const documentSourceState = props.documentSourcePresentation?.presentation.state;
    const documentSourceRetryable = documentSourceState === 'stale'
        || documentSourceState === 'offline'
        || documentSourceState === 'unavailable'
        || documentSourceState === 'failedRetry';
    const body = (
        <>
            {settingsError ? (
                <HappierValidationMessage
                    testID="plugin-declarative-settings-error"
                    message={t(
                        settingsError === 'outcomeUnknown'
                            ? 'settingsProviders.errors.mutationOutcomeUnknownDescription'
                            : settingsError === 'unavailable'
                                ? 'common.unavailable'
                                : 'common.error',
                    )}
                    accessibilityLiveRegion="polite"
                    theme={presentationTheme}
                />
            ) : null}
            {documentSourceNotice ? (
                <View testID={`plugin-declarative-document-source-status:${documentSourceState}`}>
                    <HappierValidationMessage
                        testID={documentSourceRetryable
                            ? 'plugin-declarative-document-source-error'
                            : undefined}
                        message={`${documentSourceNotice.title}. ${documentSourceNotice.reason}`}
                        accessibilityLiveRegion="polite"
                        theme={presentationTheme}
                    />
                    {documentSourceRetryable ? (
                        <HappierPressable
                            testID="plugin-declarative-document-source-retry"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.retry')}
                            onPress={props.documentSourcePresentation!.retry}
                            style={(state) => ({
                                minWidth: minimumTouchTarget,
                                minHeight: minimumTouchTarget,
                                alignSelf: 'flex-start',
                                justifyContent: 'center',
                                alignItems: 'center',
                                paddingHorizontal: presentationTheme.spacing.medium,
                                borderRadius: presentationTheme.radii.control,
                                backgroundColor: presentationTheme.colors.accent,
                                opacity: state.disabled ? 0.5 : state.pressed ? 0.8 : 1,
                            })}
                        >
                            <HappierText style={{ color: presentationTheme.colors.onAccent }}>
                                {t('common.retry')}
                            </HappierText>
                        </HappierPressable>
                    ) : null}
                </View>
            ) : null}
            {renderNode(root)}
        </>
    );
    const renderedSurface = (
        <PluginSurfaceInteractionBoundary
            surfaceId={`declarative:${props.pluginId}:${qualifiedId}`}
            snapshotTitle={localized(root.title) || qualifiedId}
            enabled={props.interactionEnabled}
            focusEligible={props.focusEligible}
        >
            {props.embeddedPresentation === 'content' ? (
                <View testID="plugin-declarative-surface-embedded-content">
                    {body}
                </View>
            ) : (
                <HappierScreen testID="plugin-declarative-surface">
                    {rootOwnsScroll ? (
                        <HappierScrollArea contentContainerStyle={{ gap: 12 }}>
                            {body}
                        </HappierScrollArea>
                    ) : (
                        <View
                            testID="plugin-declarative-surface-fill"
                            style={rootOwnsFlexViewport ? { flex: 1, minWidth: 0 } : undefined}
                        >
                            {body}
                        </View>
                    )}
                </HappierScreen>
            )}
        </PluginSurfaceInteractionBoundary>
    );
    return props.environment
        ? <HappierUiEnvironmentProvider environment={props.environment}>{renderedSurface}</HappierUiEnvironmentProvider>
        : renderedSurface;
}
