import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
    HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_KINDS_V1, HealthCheckKindCatalogV1ProtocolSchema, createHealthCheckSourceInstanceIdV1,
    HealthCheckHttpConfigV1ProtocolSchema, HealthCheckSetupDraftV1ProtocolSchema, HealthCheckSetupPreviewResultV1ProtocolSchema,
    HealthCheckDnsConfigV1ProtocolSchema, HealthCheckHeartbeatConfigV1ProtocolSchema, type HealthCheckSetupPreviewResultV1,
    HealthCheckSetupInputV1ProtocolSchema, HealthCheckTcpConfigV1ProtocolSchema, isHealthCheckLoopbackRefusedV1,
    type HealthCheckKindV1, type HealthCheckKindCatalogV1, type HealthCheckSetupDraftV1, type HealthCheckSetupInputV1, type HealthCheckSubjectV1,
} from '@happier-dev/plugin-sdk';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, resolvePluginLocalizedStringV2Text,
    type PluginJsonSchemaValidator } from '@happier-dev/plugin-sdk/manifest';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    Banner, Button, CodeBlock, Column, Columns, CountedDisclosureItem, Field, ModalCardFooterActions, Row, Select, SelectionTiles, Stack, Text, TextField,
    defineUiSurface, projectPluginActionRejectionV1, usePluginHostApi, usePluginTranslation, type IconName,
} from '@happier-dev/plugin-ui';
import { CapabilityEndpointAddressControls, SavedHeartbeatControls } from './HeartbeatSetupControls.js';
import { HEALTH_KINDS_ACTION_ID } from '../healthCatalog.js';
import { SavedHealthCheckControls } from './SavedHealthCheckControls.js';
import { SavedHealthAlertControls } from './SavedHealthAlertControls.js';
import { ContributedConfigFields, contributedConfigDraft, contributedConfigValue } from './contributedConfigFields.js';
import { isMonitorCheck, isMonitorKind, monitorDefinitions, monitorKinds, type MonitorKind } from '../monitorDefinitions.js';

export { activateHealthSetupClientActionsV1 as activate } from './actions/healthSetup.js';

type Translate = ReturnType<typeof usePluginTranslation>;
type Check = HealthCheckSetupInputV1['checks'][number];
type DraftCheck = Omit<Check, 'config'> & Readonly<{ config: unknown }>;
type DomainCondition = Extract<Check['binding'], { kind: 'domain' }>['condition'];
type SourceOptions = Pick<HealthCheckSetupInputV1, 'investigation' | 'alerts'> & Pick<HealthCheckSetupDraftV1, 'domain'>;
const K = 'machineServices.healthSetup';

/** One kind tile set; copy and marks follow the shared Add check sheet. */
type SetupKind = HealthCheckKindV1 | MonitorKind;
const KINDS: readonly Readonly<{ id: SetupKind; title: string; subtitle: string; icon: IconName }>[] = [
    { id: 'http', title: 'HTTP', subtitle: 'A page answers with a status or a word', icon: 'globe' },
    { id: 'tcp', title: 'TCP', subtitle: 'A port accepts connections', icon: 'link' },
    // Each kind its own mark, so a tile reads at a glance (PAGE-ACCEPT-176 R11-D2).
    { id: 'dns', title: 'DNS', subtitle: 'A name resolves to what you expect', icon: 'list' },
    { id: 'certificate', title: 'Certificate', subtitle: 'Valid, and renewing in time', icon: 'locked' },
    { id: 'heartbeat', title: 'Heartbeat', subtitle: 'Your job pings Happier on schedule', icon: 'heart' },
    ...monitorKinds.map(id => ({ id, title: monitorDefinitions[id].title, subtitle: monitorDefinitions[id].description,
        icon: id === 'uptime-kuma' ? 'pulse' as const : 'chart' as const })),
];
const GATUS_BODY = '{"endpointGroup":"[ENDPOINT_GROUP]","endpointName":"[ENDPOINT_NAME]","status":"[ALERT_TRIGGERED_OR_RESOLVED]"}';
const MINUTE = 60_000;
const PERIODS = [[MINUTE, '1 minute'], [5 * MINUTE, '5 minutes'], [15 * MINUTE, '15 minutes'], [60 * MINUTE, '1 hour']] as const;
const THRESHOLDS = [[1, 'The first failure'], [2, '2 failures in a row'], [3, '3 failures in a row'], [5, '5 failures in a row']] as const;
const GRACE = [[0, 'No grace'], [MINUTE, '1 minute'], [5 * MINUTE, '5 minutes'], [15 * MINUTE, '15 minutes']] as const;
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'PTR', 'SRV', 'SOA', 'NAPTR', 'CAA'] as const;

type Draft = Readonly<{
    kind: SetupKind; endpoint: string; expectStatus: string; keyword: string; host: string; port: string;
    hostname: string; recordType: (typeof RECORD_TYPES)[number]; expectedAnswer: string; graceMs: number;
    periodMs: number; consecutiveFailuresBeforeAlerting: number;
    contributedKind?: HealthCheckKindCatalogV1[number]; contributedValidator?: PluginJsonSchemaValidator;
    /** What the person entered in the installed kind's typed fields. */
    contributedDraft?: unknown;
    monitorId?: string; endpointGroup?: string; endpointName?: string;
    domainCondition?: DomainCondition;
}>;
const EMPTY: Draft = { kind: 'http', endpoint: '', expectStatus: '200', keyword: '', host: '', port: '', hostname: '',
    recordType: 'A', expectedAnswer: '', graceMs: MINUTE, periodMs: MINUTE, consecutiveFailuresBeforeAlerting: 1 };

type RendererDraft = Readonly<{
    check: Draft | null;
    alerts?: SourceOptions['alerts'];
    preparedPreview?: HealthCheckSetupPreviewResultV1;
}>;

function readRendererDraft(value: unknown, subject: HealthCheckSubjectV1): RendererDraft | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const { check, alerts, preparedPreview } = value as Readonly<Record<string, unknown>>;
    const prepared = HealthCheckSetupPreviewResultV1ProtocolSchema.safeParse(preparedPreview);
    const previewSubject = prepared.success ? prepared.data.sourceConfig.subject : undefined;
    let restored: Draft | null = null;
    if (typeof check === 'object' && check !== null && !Array.isArray(check)) {
        const record = check as Readonly<Record<string, unknown>>;
        const kind = KINDS.find(kind => kind.id === record.kind)?.id;
        const recordType = RECORD_TYPES.find(type => type === record.recordType);
        const restoredFields = Object.fromEntries(Object.entries(EMPTY).map(([key, fallback]) => [
            key, typeof record[key] === typeof fallback ? record[key] : fallback,
        ])) as typeof EMPTY;
        const contributed = HealthCheckKindCatalogV1ProtocolSchema.safeParse([record.contributedKind]);
        const contributedKind = contributed.success ? contributed.data[0] : undefined;
        restored = {
            ...restoredFields, kind: kind ?? EMPTY.kind, recordType: recordType ?? EMPTY.recordType,
            ...(typeof record.monitorId === 'string' ? { monitorId: record.monitorId } : {}),
            ...(typeof record.endpointGroup === 'string' ? { endpointGroup: record.endpointGroup } : {}),
            ...(typeof record.endpointName === 'string' ? { endpointName: record.endpointName } : {}),
            ...(contributedKind ? { contributedKind, contributedValidator: compilePluginJsonSchema(contributedKind.configSchema),
                contributedDraft: record.contributedDraft } : {}),
        };
    }
    const parsedAlerts = HealthCheckSetupDraftV1ProtocolSchema.safeParse({ v: 1, alerts });
    return {
        check: restored,
        ...(prepared.success && prepared.data.sourceConfig.alerts && subject.kind === 'environment'
            && previewSubject?.kind === 'environment' && previewSubject.environmentId === subject.environmentId
            ? { preparedPreview: prepared.data } : {}),
        ...(parsedAlerts.success && parsedAlerts.data.alerts ? { alerts: parsedAlerts.data.alerts } : {}),
    };
}

function contributedCheckDraft(kind: HealthCheckKindCatalogV1[number], config?: unknown) {
    return {
        contributedKind: kind,
        contributedValidator: compilePluginJsonSchema(kind.configSchema),
        contributedDraft: contributedConfigDraft(kind.configSchema, config),
    };
}

function readSavedCheckDraft(check: Check | undefined, kind: HealthCheckKindCatalogV1[number] | undefined): Draft | null {
    if (!check) return null;
    const cadence = {
        periodMs: check.periodMs,
        consecutiveFailuresBeforeAlerting: check.consecutiveFailuresBeforeAlerting,
        ...(check.binding.kind === 'domain' ? { domainCondition: check.binding.condition } : {}),
    };
    if (kind) return { ...EMPTY, ...cadence, ...contributedCheckDraft(kind, check.config) };
    if (check.kind.pluginId === HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1) {
        if (check.binding.kind === 'domain' && (check.kind.localId === 'http' || check.kind.localId === 'certificate')) {
            return { ...EMPTY, ...cadence, kind: check.kind.localId };
        }
        if (check.kind.localId === 'heartbeat') {
            const config = HealthCheckHeartbeatConfigV1ProtocolSchema.safeParse(check.config);
            return config.success ? { ...EMPTY, ...cadence, kind: 'heartbeat', graceMs: config.data.graceMs } : null;
        }
        if (check.kind.localId === 'http' || check.kind.localId === 'certificate') {
            const config = HealthCheckHttpConfigV1ProtocolSchema.safeParse(check.config);
            return config.success && 'endpoint' in config.data
                ? { ...EMPTY, ...cadence, kind: check.kind.localId, endpoint: config.data.endpoint,
                    expectStatus: String(config.data.expectStatus), keyword: config.data.keyword ?? '' }
                : null;
        }
        if (check.kind.localId === 'tcp') {
            const config = HealthCheckTcpConfigV1ProtocolSchema.safeParse(check.config);
            return config.success ? { ...EMPTY, ...cadence, kind: 'tcp', host: config.data.host, port: String(config.data.port) } : null;
        }
        if (check.kind.localId === 'dns') {
            const config = HealthCheckDnsConfigV1ProtocolSchema.safeParse(check.config);
            return config.success ? { ...EMPTY, ...cadence, kind: 'dns', hostname: config.data.hostname,
                recordType: config.data.recordType, expectedAnswer: config.data.expectedAnswer ?? '' } : null;
        }
    }
    if (!isMonitorCheck(check)) return null;
    if (check.kind.localId === 'uptime-kuma') {
        const config = monitorDefinitions['uptime-kuma'].configSchema.safeParse(check.config);
        return config.success ? { ...EMPTY, ...cadence, kind: 'uptime-kuma', monitorId: config.data.monitorId } : null;
    }
    const config = monitorDefinitions.gatus.configSchema.safeParse(check.config);
    return config.success ? { ...EMPTY, ...cadence, kind: 'gatus',
        endpointGroup: config.data.endpointGroup, endpointName: config.data.endpointName } : null;
}

/** The host hands the prebound draft; an observer, when the host names it, decides loopback in place. */
function readLaunch(input: unknown): Readonly<{
    draft: HealthCheckSetupDraftV1;
    observerMachineId?: string;
    selectedCheckId?: string;
    rendererDraft?: RendererDraft;
}> | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const record = input as Readonly<Record<string, unknown>>;
    const initial = record.initialInput;
    if (typeof initial !== 'object' || initial === null || Array.isArray(initial)) return null;
    const { selectedCheckId, rendererDraft, ...setupDraft } = initial as Readonly<Record<string, unknown>>;
    const draft = HealthCheckSetupDraftV1ProtocolSchema.safeParse(setupDraft);
    if (!draft.success || draft.data.subject === undefined) return null;
    if (selectedCheckId !== undefined && (typeof selectedCheckId !== 'string'
        || !draft.data.checks?.some(check => check.checkId === selectedCheckId))) return null;
    const observer = record.observerMachineId;
    return { draft: draft.data, ...(typeof observer === 'string' && observer.length > 0 ? { observerMachineId: observer } : {}),
        ...(selectedCheckId === undefined ? {} : { selectedCheckId }),
        rendererDraft: readRendererDraft(rendererDraft, draft.data.subject) };
}

function configFor(draft: Draft, retainedMonitorConfig?: Check['config']): unknown {
    if (draft.contributedKind) return contributedConfigValue(draft.contributedKind.configSchema, draft.contributedDraft);
    if (isMonitorKind(draft.kind)) {
        const retained = retainedMonitorConfig !== null && typeof retainedMonitorConfig === 'object'
            && !Array.isArray(retainedMonitorConfig) ? retainedMonitorConfig : undefined;
        return draft.kind === 'uptime-kuma' ? { ...retained, monitorId: (draft.monitorId ?? '').trim() }
            : { ...retained, endpointGroup: draft.endpointGroup ?? '', endpointName: draft.endpointName ?? '' };
    }
    const optional = (key: string, value: string) => (value.trim() ? { [key]: value.trim() } : {});
    if (draft.kind === 'tcp') return { host: draft.host.trim(), port: Number(draft.port) };
    if (draft.kind === 'dns') return { hostname: draft.hostname.trim(), recordType: draft.recordType,
        ...optional('expectedAnswer', draft.expectedAnswer) };
    if (draft.kind === 'heartbeat') {
        const existing = HealthCheckHeartbeatConfigV1ProtocolSchema.safeParse(retainedMonitorConfig);
        return { ...(existing.success ? existing.data : {}), graceMs: draft.graceMs };
    }
    return { endpoint: draft.endpoint.trim(), expectStatus: Number(draft.expectStatus), ...optional('keyword', draft.keyword) };
}

/** Unbound checks retain every existing check and receive a unique id. */
function nextCheckId(kind: string, existing: readonly Readonly<{ checkId: string }>[]): string {
    const taken = new Set(existing.map(check => check.checkId));
    if (!taken.has(kind)) return kind;
    let index = 2;
    while (taken.has(`${kind}-${index}`)) index += 1;
    return `${kind}-${index}`;
}

/** Changing a Domain condition's producer preserves its saved identity and every sibling. */
function putCheck(existing: readonly DraftCheck[], check: DraftCheck): DraftCheck[] {
    const binding = check.binding;
    const index = binding.kind === 'domain' ? existing.findIndex(current => current.binding.kind === 'domain'
        && current.binding.domainId === binding.domainId && current.binding.targetLinkId === binding.targetLinkId
        && current.binding.condition === binding.condition) : -1;
    return index < 0 ? [...existing, check] : existing.map((current, position) => position === index
        ? { ...check, checkId: current.checkId } : current);
}

export function buildHealthCheckSetupInput(subject: HealthCheckSubjectV1, existing: readonly Check[], draft: Draft,
    options: SourceOptions = {}) {
    const { domain, ...sourceOptions } = options;
    if (domain && !draft.contributedKind && !isMonitorKind(draft.kind)) {
        let checks: DraftCheck[] = [...existing];
        for (const [localId, condition] of [['http', 'domain_probe_failed'], ['certificate', 'certificate_renewal_failed']] as const) {
            checks = putCheck(checks, { checkId: nextCheckId(localId, checks), kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId },
                binding: { kind: 'domain', ...domain, condition }, config: {}, periodMs: draft.periodMs,
                consecutiveFailuresBeforeAlerting: draft.consecutiveFailuresBeforeAlerting });
        }
        return HealthCheckSetupInputV1ProtocolSchema.safeParse({ v: 1, subject, ...sourceOptions, checks });
    }
    const kind = draft.contributedKind ? { pluginId: draft.contributedKind.pluginId, localId: draft.contributedKind.id }
        : { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: draft.kind };
    return HealthCheckSetupInputV1ProtocolSchema.safeParse({ v: 1, subject, ...sourceOptions, checks: putCheck(existing, {
        checkId: nextCheckId(kind.localId, existing), kind,
        binding: domain ? { kind: 'domain', ...domain, condition: draft.domainCondition ?? 'domain_probe_failed' }
            : { kind: 'healthCheck' }, config: configFor(draft),
        periodMs: draft.periodMs, consecutiveFailuresBeforeAlerting: draft.consecutiveFailuresBeforeAlerting,
    }) });
}

/** Field problems come from the kind's own config schema; empty fields only keep Add check unavailable. */
function fieldIssues(draft: Draft, text: Translate) {
    const http = !draft.contributedKind && (draft.kind === 'http' || draft.kind === 'certificate');
    const endpointValid = HealthCheckHttpConfigV1ProtocolSchema.safeParse({ endpoint: draft.endpoint.trim(), expectStatus: 200 }).success;
    const statusValid = !endpointValid || HealthCheckHttpConfigV1ProtocolSchema.safeParse(configFor(draft)).success;
    const portValid = HealthCheckTcpConfigV1ProtocolSchema.safeParse({ host: 'host', port: Number(draft.port) }).success;
    return {
        endpoint: http && draft.endpoint.trim() && !endpointValid
            ? text(`${K}.endpoint.invalid`, 'Enter an http:// or https:// address, without a user name or password.') : undefined,
        expectStatus: http && draft.expectStatus.trim() && !statusValid
            ? text(`${K}.expectStatus.invalid`, 'Use a status code from 100 to 599.') : undefined,
        port: draft.kind === 'tcp' && draft.port.trim() && !portValid
            ? text(`${K}.port.invalid`, 'Use a port from 1 to 65535.') : undefined,
    };
}

/** Equal columns that recompose to one on narrow widths (the shared Columns owner). */
function columns(key: string, count: 2 | 3, ...cells: ReactElement[]) {
    return h(Columns, { key, columns: count, minColumnWidth: 180 }, ...cells.map((cell, index) => h(Column, { key: index }, cell)));
}

function choice<T extends number>(
    label: string, value: T, options: readonly (readonly [T, string])[], onChange: (next: T) => void, testID: string,
) {
    return h(Field, { label },
        h(Select, { label, presentation: 'field', value, testID,
            options: options.map(([option, title]) => ({ value: option, label: title })),
            onChange: next => { if (typeof next === 'number') onChange(next as T); } }));
}

function text(label: string, value: string, onChange: (next: string) => void, options: Readonly<{
    description?: string; issue?: string; placeholder?: string; monospace?: boolean; url?: boolean; numeric?: boolean;
    required?: boolean; testID: string;
}>) {
    return h(Field, { label, ...(options.description ? { description: options.description } : {}),
        ...(options.issue ? { issue: options.issue } : {}), required: options.required ?? true },
    h(TextField, { label, value, onChange, presentation: 'field', testID: options.testID,
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
        ...(options.monospace ? { monospace: true } : {}),
        ...(options.url ? { keyboardType: 'url' as const, autoCapitalize: 'none' as const, autoCorrect: false } : {}),
        ...(options.numeric ? { keyboardType: 'numeric' as const } : {}) }));
}

function HealthCheckSetupForm(props: Readonly<{ subject: HealthCheckSubjectV1; existing: readonly Check[];
    sourceOptions: SourceOptions;
    newContributedCheck?: HealthCheckSetupDraftV1['newContributedCheck'];
    observerMachineId?: string; selectedCheckId?: string; rendererDraft?: RendererDraft; signal: AbortSignal }>): ReactElement {
    const t = usePluginTranslation();
    const host = usePluginHostApi();
    const resumedPreview = props.rendererDraft?.preparedPreview;
    const [preparedPreview, setPreparedPreview] = useState(resumedPreview);
    const existing = preparedPreview?.sourceConfig.checks ?? props.existing;
    const [selectedCheckId, setSelectedCheckId] = useState<string | null>(props.selectedCheckId ?? null);
    const [editedDraft, setEditedDraft] = useState<Draft | null>(props.rendererDraft?.check ?? null);
    const domain = props.sourceOptions.domain;
    // Add check (a launch that holds no checks) starts empty beside whatever the source already has; a source opened
    // for editing restores its first check (PAGE-ACCEPT-176 R10-D1).
    const addingNew = props.existing.length === 0 && props.selectedCheckId === undefined;
    const selectedCheck = existing.find(check => check.checkId === selectedCheckId) ?? (domain
        ? existing.find(({ binding }) => binding.kind === 'domain'
            && binding.domainId === domain.domainId && binding.targetLinkId === domain.targetLinkId)
        : addingNew ? undefined : existing[0]);
    const [catalog, setCatalog] = useState<HealthCheckKindCatalogV1 | null>(null);
    const selectedKind = catalog?.find(kind =>
        kind.pluginId === selectedCheck?.kind.pluginId && kind.id === selectedCheck.kind.localId);
    const restoredDraft = useMemo(() => readSavedCheckDraft(selectedCheck, selectedKind), [selectedCheck, selectedKind]);
    const intent = props.newContributedCheck;
    const initialKind = intent && catalog?.find(kind => kind.pluginId === intent.kind.pluginId && kind.id === intent.kind.localId);
    const initialDraft = useMemo(() => initialKind && intent ? {
        ...EMPTY, ...contributedCheckDraft(initialKind, intent.config),
    } : null, [initialKind, intent]);
    const draft = editedDraft ?? restoredDraft ?? initialDraft ?? EMPTY;
    const [{ editedAlerts, preparedSource }, setAlertDraft] = useState({
        editedAlerts: props.rendererDraft?.alerts,
        preparedSource: props.rendererDraft?.alerts === undefined ? resumedPreview?.testContext : undefined,
    });
    const setAlerts = (next: NonNullable<SourceOptions['alerts']>) => {
        setAlertDraft(current => ({ ...current, editedAlerts: next }));
    };
    const alertsEdited = editedAlerts !== undefined;
    const alerts = editedAlerts ?? props.sourceOptions.alerts ?? preparedPreview?.sourceConfig.alerts;
    const destinationSelectionContext = preparedPreview?.destinationSelectionContext;
    const [previewFailure, setPreviewFailure] = useState<{ error: unknown } | null>(null);
    const [previewAttempt, setPreviewAttempt] = useState(0);
    useEffect(() => {
        // Switching watchers resumes the same Environment form. Project/Account defaults belong to the
        // Environment and have already settled inside this form's lifetime.
        if (resumedPreview) return;
        setPreviewFailure(null);
        let retired = false;
        const { domain, ...sourceOptions } = props.sourceOptions;
        void host.executeAction({ pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health/setup' }, {
            v: 1, mode: 'preview', subject: props.subject, ...(props.existing.length ? { checks: props.existing } : {}), ...sourceOptions,
        }, { signal: props.signal }).then(value => {
            if (retired || props.signal.aborted) return;
            const prepared = HealthCheckSetupPreviewResultV1ProtocolSchema.safeParse(value);
            if (!prepared.success) {
                setPreviewFailure({ error: { code: 'invalid_action_output' } });
                return;
            }
            setPreparedPreview(prepared.data);
            setAlertDraft(current => ({ ...current,
                preparedSource: current.editedAlerts === undefined ? prepared.data.testContext : undefined,
            }));
        }).catch(error => { if (!retired && !props.signal.aborted) setPreviewFailure({ error }); });
        return () => { retired = true; };
    }, [host, props.signal, props.subject, props.existing, props.sourceOptions, previewAttempt, resumedPreview]);
    const previewRefusal = previewFailure && projectPluginActionRejectionV1(previewFailure.error, t);
    const [saving, setSaving] = useState(false);
    // The host's refusal of this Save, in its own words when it gave them; the entries stay for a correction.
    const [refusedSave, setRefusedSave] = useState<string | null>(null);
    const [loadingKinds, setLoadingKinds] = useState(false);
    const [gatusHowOpen, setGatusHowOpen] = useState(false);
    const [kindsUnavailable, setKindsUnavailable] = useState(false);
    const nativeDomain = props.sourceOptions.domain !== undefined && !draft.contributedKind && !isMonitorKind(draft.kind);
    const edit = (update: (current: Draft) => Draft) => {
        setEditedDraft(current => update(current ?? draft));
        setRefusedSave(null);
    };
    const set = (patch: Partial<Draft>) => edit(current => ({ ...current, ...patch }));
    const selectSavedCheck = (checkId: string) => {
        setSelectedCheckId(checkId);
        setEditedDraft(null);
        setRefusedSave(null);
    };
    const selectContributed = (kind: HealthCheckKindCatalogV1[number]) => set(contributedCheckDraft(kind));
    const readInstalledKinds = useCallback(async () => {
        setLoadingKinds(true);
        setKindsUnavailable(false);
        try {
            const kinds = HealthCheckKindCatalogV1ProtocolSchema.parse(await host.executeAction(
                { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: HEALTH_KINDS_ACTION_ID }, {}, { signal: props.signal }))
                .filter(kind => kind.pluginId !== HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1
                    || (!HEALTH_CHECK_KINDS_V1.some(native => native === kind.id) && !isMonitorKind(kind.id)));
            if (!props.signal.aborted) {
                setCatalog(kinds);
                return kinds;
            }
        } catch { if (!props.signal.aborted) setKindsUnavailable(true); }
        finally { if (!props.signal.aborted) setLoadingKinds(false); }
        return null;
    }, [host, props.signal]);
    const savedContributedKind = selectedCheck && selectedCheck.kind.pluginId !== HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1;
    useEffect(() => {
        if ((savedContributedKind || intent) && catalog === null) void readInstalledKinds();
    }, [catalog, intent, readInstalledKinds, savedContributedKind]);
    const issues = fieldIssues(draft, t);
    const candidate = buildHealthCheckSetupInput(props.subject, existing, draft, { ...props.sourceOptions,
        ...(alerts === undefined ? {} : { alerts }),
        investigation: { mode: 'inbox' } });
    const loopback = props.observerMachineId === undefined || draft.contributedKind || nativeDomain ? null : {
        refused: isHealthCheckLoopbackRefusedV1({ subject: props.subject, observerMachineId: props.observerMachineId,
            kindLocalId: draft.kind, config: configFor(draft) }),
        sameMachine: props.subject.kind === 'machineService' && props.observerMachineId === props.subject.machineId,
    };
    const hostBearing = !draft.contributedKind && (draft.kind === 'http' || draft.kind === 'certificate' || draft.kind === 'tcp');
    const hostHint = loopback?.sameMachine
        ? t(`${K}.loopback.sameMachine`, 'Checked from the service’s own Machine: this catches a stopped service, not a broken route or firewall.')
        : t(`${K}.loopback.hint`, 'A loopback address such as 127.0.0.1 works only when the check runs on the service’s own Machine.');
    const contributedValid = !draft.contributedKind || (draft.contributedValidator !== undefined
        && isValidPluginJsonSchemaValue(draft.contributedValidator, configFor(draft)));
    const monitorKind = !draft.contributedKind && isMonitorKind(draft.kind) ? draft.kind : null;
    const monitorValid = !monitorKind || monitorDefinitions[monitorKind].configSchema.safeParse(configFor(draft)).success;
    const matchesSavedKind = restoredDraft && (draft.contributedKind
        ? draft.contributedKind === restoredDraft.contributedKind
        : !restoredDraft.contributedKind && draft.kind === restoredDraft.kind);
    const editedCheck = editedDraft !== null && matchesSavedKind ? selectedCheck : undefined;
    const savedEditValid = !editedCheck || (contributedValid && monitorValid && loopback?.refused !== true);
    const savedChecks = editedCheck ? existing.map(check => check === editedCheck ? {
        ...check, config: nativeDomain ? check.config : configFor(draft, check.config),
        periodMs: monitorKind ? check.periodMs : draft.periodMs,
        consecutiveFailuresBeforeAlerting: draft.consecutiveFailuresBeforeAlerting,
    } : check) : existing;
    const savedCandidate = HealthCheckSetupInputV1ProtocolSchema.safeParse({ v: 1, subject: props.subject, checks: savedChecks,
        alerts, investigation: { mode: 'inbox' } });
    const validAddition = candidate.success && contributedValid && monitorValid && loopback?.refused !== true;
    const canAdd = alerts !== undefined && validAddition && !saving;
    const defaultsPending = alerts === undefined && (previewRefusal === null || previewRefusal.status === 'pending');
    const domainConditions = [
        { value: 'domain_probe_failed', label: t(`${K}.domain.route`, 'Route check') },
        { value: 'certificate_renewal_failed', label: t(`${K}.domain.certificate`, 'Certificate renewal') },
    ] satisfies readonly Readonly<{ value: DomainCondition; label: string }>[];

    const refusal = hostBearing && loopback?.refused ? h(Banner, { key: 'loopback', tone: 'warning', testID: 'health-setup-loopback-refused',
            title: t(`${K}.loopback.refused.title`, 'This address means the Machine running the check'),
            description: t(`${K}.loopback.refused.description`,
                'A check from another Machine would connect to itself, not to this service. Run the check on the service’s own Machine, or enter an address other Machines can reach.') }) : null;
    const cadence = [
        choice(draft.kind === 'heartbeat' ? t(`${K}.every.heartbeat`, 'Expect a ping every') : t(`${K}.every`, 'Every'),
            draft.periodMs, PERIODS, periodMs => set({ periodMs }), 'health-setup-every'),
        choice(t(`${K}.alertAfter`, 'Alert after'), draft.consecutiveFailuresBeforeAlerting, THRESHOLDS,
            consecutiveFailuresBeforeAlerting => set({ consecutiveFailuresBeforeAlerting }), 'health-setup-alert-after'),
    ];
    const fields = nativeDomain ? [
        h(Text, { key: 'domain-about', tone: 'secondary', value: t(`${K}.domain.about`,
            'Check this Domain’s saved route and certificate. Choose how often to check and when to alert, then enable the checks.') }),
        columns('cadence', 2, ...cadence),
    ] : draft.contributedKind ? [
        h(ContributedConfigFields, { key: `${draft.contributedKind.pluginId}/${draft.contributedKind.id}`,
            schema: draft.contributedKind.configSchema, draft: draft.contributedDraft,
            onChange: update => edit(current => ({ ...current, contributedDraft: update(current.contributedDraft) })) }),
        columns('cadence', 2, ...cadence),
    ] : monitorKind ? [
        // A saved check's address is already below; only a new one waits for Save (R13-D9).
        h(Text, { key: 'monitor-about', tone: 'secondary', value: props.selectedCheckId !== undefined || selectedCheckId !== null
            ? t(`${K}.monitor.aboutSaved`, 'Happier uses this monitor’s updates. Set the provider to send JSON with POST to the address below.')
            : t(`${K}.monitor.about`, 'Happier uses this monitor’s updates. After saving, reveal its address here and set the provider to send JSON with POST.') }),
        ...(monitorKind === 'uptime-kuma' ? [text(t(`${K}.monitorId`, 'Monitor ID'), draft.monitorId ?? '', value => set({ monitorId: value }), {
            numeric: true, testID: 'health-setup-monitor-id' })] : [
            text(t(`${K}.endpointGroup`, 'Endpoint group'), draft.endpointGroup ?? '', value => set({ endpointGroup: value }), {
                required: false, testID: 'health-setup-endpoint-group' }),
            text(t(`${K}.endpointName`, 'Endpoint name'), draft.endpointName ?? '', value => set({ endpointName: value }), {
                testID: 'health-setup-endpoint-name' }),
            // How to connect Gatus waits one press away, as the shared disclosure row with its caret, its body as
            // copyable code (PAGE-ACCEPT-176 R11-D2, R13-D9).
            h(CountedDisclosureItem, { key: 'gatus-how', testID: 'health-setup-gatus-how',
                title: t(`${K}.monitor.gatusHow`, 'How to connect Gatus'), expanded: gatusHowOpen, onExpandedChange: setGatusHowOpen,
                children: h(Stack, { gap: 'small' },
                    h(Text, { tone: 'secondary', value: t(`${K}.monitor.gatusTemplateLead`,
                        'In Gatus, add a custom alert that sends POST with Content-Type application/json and this body:') }),
                    h(CodeBlock, { code: GATUS_BODY, language: 'json', selectable: true })) }),
        ]),
        cadence[1]!,
    ] : draft.kind === 'tcp' ? [
        text(t(`${K}.host`, 'Host'), draft.host, value => set({ host: value }), { monospace: true, url: true,
            placeholder: 'db.internal', description: hostHint, testID: 'health-setup-host' }),
        refusal,
        columns('cadence', 3,
            text(t(`${K}.port`, 'Port'), draft.port, value => set({ port: value }), { numeric: true, placeholder: '5432',
                ...(issues.port ? { issue: issues.port } : {}), testID: 'health-setup-port' }),
            ...cadence),
    ] : draft.kind === 'dns' ? [
        columns('target', 2,
            text(t(`${K}.hostname`, 'Name'), draft.hostname, value => set({ hostname: value }), { monospace: true, url: true,
                placeholder: 'shop.example.com', testID: 'health-setup-hostname' }),
            h(Field, { label: t(`${K}.recordType`, 'Record') }, h(Select, { label: t(`${K}.recordType`, 'Record'),
                presentation: 'field', value: draft.recordType, testID: 'health-setup-record-type',
                options: RECORD_TYPES.map(type => ({ value: type, label: type })),
                onChange: next => { const found = RECORD_TYPES.find(type => type === next); if (found) set({ recordType: found }); } }))),
        text(t(`${K}.expectedAnswer`, 'Expected answer'), draft.expectedAnswer, value => set({ expectedAnswer: value }), {
            monospace: true, required: false, placeholder: '203.0.113.10',
            description: t(`${K}.expectedAnswer.hint`, 'Leave empty to only check that the name resolves.'), testID: 'health-setup-expected-answer' }),
        columns('cadence', 2, ...cadence),
    ] : draft.kind === 'heartbeat' ? [
        h(Text, { key: 'about', tone: 'secondary', value: t(`${K}.heartbeat.about`,
            'After you add the check, Happier gives your job an address to ping. A missed ping counts as a failure.') }),
        columns('cadence', 3, cadence[0]!,
            choice(t(`${K}.grace`, 'Grace'), draft.graceMs, GRACE, graceMs => set({ graceMs }), 'health-setup-grace'), cadence[1]!),
    ] : [
        text(t(`${K}.endpoint`, 'Endpoint'), draft.endpoint, value => set({ endpoint: value }), { monospace: true, url: true,
            placeholder: draft.kind === 'certificate' ? 'https://shop.example.com' : 'https://status.example.com',
            description: hostHint, ...(issues.endpoint ? { issue: issues.endpoint } : {}), testID: 'health-setup-endpoint' }),
        refusal,
        columns('cadence', 3,
            text(t(`${K}.expectStatus`, 'Expect status'), draft.expectStatus, value => set({ expectStatus: value }), {
                numeric: true, ...(issues.expectStatus ? { issue: issues.expectStatus } : {}), testID: 'health-setup-expect-status' }),
            ...cadence),
        ...(draft.kind === 'http' ? [text(t(`${K}.keyword`, 'Page contains'), draft.keyword, value => set({ keyword: value }), {
            required: false, placeholder: 'All systems operational', testID: 'health-setup-keyword' })] : []),
    ];

    // One primary, in the card's footer beside Cancel (PAGE-ACCEPT-176 R10-D1, R11-D1, R11-D3):
    // - a saved check opened to edit (the check's own sheet) saves changes, and its kind stays fixed;
    // - a new check reads "Add check" from the start; only alerts changed with no check entered save as changes;
    // - a Domain's default checks are enabled;
    // - a source opened for editing with no check chosen keeps both, since it may edit its check or add another.
    const editingCheck = props.selectedCheckId !== undefined;
    const editingSaved = editingCheck || selectedCheckId !== null;
    const savesChanges = !nativeDomain && (editingSaved || (addingNew && editedDraft === null && alertsEdited));
    const offersBoth = !nativeDomain && !editingSaved && !addingNew;
    const submit = async (input: HealthCheckSetupInputV1) => {
        setSaving(true);
        try {
            await host.settleEphemeralInput({ kind: 'completed', input }, { signal: props.signal });
        } catch (error) {
            const refusal = projectPluginActionRejectionV1(error, t);
            if (refusal.status === 'error' || refusal.status === 'outcomeUnknown') {
                setRefusedSave(refusal.authoredMessage ?? t(`${K}.saveRefused`, 'This check can’t be added right now. Your entries are kept here.'));
            }
        } finally {
            setSaving(false);
        }
    };
    const saveChanges = (variant: 'primary' | 'secondary') => h(Button, { title: t(`${K}.saveChanges`, 'Save changes'), variant,
            disabled: alerts === undefined || !savedCandidate.success || !savedEditValid || saving,
            busy: saving, testID: 'health-setup-save',
            onPress: async () => { if (savedCandidate.success && savedEditValid) await submit(savedCandidate.data); } });
    const primaryStatus = saving ? t(`${K}.saving`, 'Saving check…')
        : defaultsPending ? t(`${K}.alerts.loadingDefaults`, 'Loading alert defaults…')
        : alerts !== undefined && !(savesChanges ? savedCandidate.success && savedEditValid : validAddition)
            && loopback?.refused !== true ? t(`${K}.requiredFields`, 'Fill in the required fields to add this check.')
        : null;
    const primary = savesChanges ? saveChanges('primary')
        : h(Button, { title: nativeDomain ? t(`${K}.enable`, 'Enable checks') : t(`${K}.add`, 'Add check'), variant: 'primary',
            disabled: !canAdd, busy: saving, testID: 'health-setup-add',
            onPress: async () => { if (candidate.success) await submit(candidate.data); } });

    if (intent && !initialDraft) {
        const waiting = catalog === null && !kindsUnavailable;
        return h(Stack, { gap: 'medium' },
            h(Text, { value: waiting ? t(`${K}.loadingKinds`, 'Loading check kinds…')
                : kindsUnavailable ? t(`${K}.kindsUnavailable`, 'Check kinds could not be loaded. Try again.')
                    : t(`${K}.requestedKindUnavailable`, 'This check kind is unavailable on the selected Machine.') }),
            h(ModalCardFooterActions, { cancel: { testID: 'health-setup-cancel',
                onPress: () => { void host.settleEphemeralInput({ kind: 'cancelled' }, { signal: props.signal }); } } },
                waiting ? null : h(Button, { title: t(`${K}.retry`, 'Retry'), onPress: () => { void readInstalledKinds(); } })));
    }
    // What to check leads: the saved check being edited, its kind and that kind's fields; alerts, what happens when it
    // needs attention and the one Save follow. A check opened to edit is its own sheet: no other saved check to pick
    // and its kind fixed.
    return h(Stack, { gap: 'large', testID: 'health-setup-form' },
        selectedCheck && !editingCheck ? h(SavedHealthCheckControls, { subject: props.subject, checks: existing, check: selectedCheck,
            onSelect: selectSavedCheck, signal: props.signal }) : null,
        // Two kinds a row at most, one on a phone: each tile's title and line read whole.
        editingCheck ? null : h(SelectionTiles<SetupKind>, { accessibilityLabel: t(`${K}.kind`, 'Kind of check'), testID: 'health-setup-kind',
            value: draft.contributedKind ? null : draft.kind,
            onChange: (kind: SetupKind) => set({ kind, contributedKind: undefined, contributedValidator: undefined }), maximumColumns: 2,
            minimumTileWidth: 220,
            options: KINDS.filter(kind => !props.sourceOptions.domain || kind.id === 'http' || isMonitorKind(kind.id))
                .map(kind => ({ id: kind.id, icon: kind.icon, title: kind.id === 'http' && props.sourceOptions.domain ? 'HTTP and certificate' : kind.title,
                ...(kind.id === 'http' && props.sourceOptions.domain ? {} : { titleKey: `${K}.kind.${kind.id}` }),
                subtitle: kind.subtitle, subtitleKey: `${K}.kind.${kind.id}.subtitle` })) }),
        editingCheck ? null : h(Row, { justify: 'flex-start' }, h(Button, { title: t(`${K}.more`, 'More checks'), variant: 'plain', busy: loadingKinds, disabled: loadingKinds,
            onPress: async () => {
                const kinds = await readInstalledKinds();
                if (kinds?.[0] && !savedContributedKind) selectContributed(kinds[0]);
            } })),
        catalog && catalog.length > 0 ? h(Field, { label: t(`${K}.contributed`, 'Installed check') }, h(Select, {
            label: t(`${K}.contributed`, 'Installed check'), presentation: 'field',
            value: draft.contributedKind ? `${draft.contributedKind.pluginId}/${draft.contributedKind.id}` : undefined,
            options: catalog.map(kind => ({ value: `${kind.pluginId}/${kind.id}`, label: resolvePluginLocalizedStringV2Text(kind.title) })),
            onChange: value => { const kind = catalog.find(item => `${item.pluginId}/${item.id}` === value); if (kind) selectContributed(kind); },
        })) : null,
        catalog?.length === 0 ? h(Text, { tone: 'secondary', value: t(`${K}.none`, 'No additional check kinds are installed.') }) : null,
        kindsUnavailable ? h(Text, { tone: 'secondary', value: t(`${K}.kindsUnavailable`, 'Check kinds could not be loaded. Try again.') }) : null,
        props.sourceOptions.domain && !nativeDomain ? h(Field, { label: t(`${K}.domain.condition`, 'Domain alert') }, h(Select, {
            label: t(`${K}.domain.condition`, 'Domain alert'), presentation: 'field', value: draft.domainCondition ?? 'domain_probe_failed',
            options: domainConditions,
            onChange: value => { const condition = domainConditions.find(item => item.value === value);
                if (condition) set({ domainCondition: condition.value }); },
        })) : null,
        ...fields,
        h(SavedHeartbeatControls, { subject: props.subject, checks: existing, signal: props.signal }),
        ...existing.flatMap(check => {
            if (!isMonitorCheck(check)) return [];
            const kind = check.kind.localId;
            const parsed = monitorDefinitions[kind].configSchema.safeParse(check.config);
            if (!parsed.success || !parsed.data.webhookEndpointId) return [];
            return [h(CapabilityEndpointAddressControls, { key: `${createHealthCheckSourceInstanceIdV1(props.subject)}:${check.checkId}:${parsed.data.webhookEndpointId}`,
                webhookEndpointId: parsed.data.webhookEndpointId, signal: props.signal,
                // What the address is for, in words, never the raw "Gatus: gatus" (R13-D9).
                title: t(`${K}.monitor.addressTitle.${kind}`, `Where ${monitorDefinitions[kind].title} sends its updates`) })];
        }),
        previewRefusal && (previewRefusal.status === 'error' || previewRefusal.status === 'outcomeUnknown')
            ? h(Stack, {}, h(Text, { value: t(`${K}.previewUnavailable`, 'Alert defaults could not be loaded. Your entries are kept here.') }),
                h(Text, { value: previewRefusal.message }),
                previewRefusal.requestId ? h(Text, { value: previewRefusal.requestId }) : null,
                h(Button, { title: t(`${K}.previewRetry`, 'Retry alert defaults'), variant: 'secondary',
                    onPress: () => setPreviewAttempt(value => value + 1) })) : null,
        h(SavedHealthAlertControls, {
            alerts,
            onChange: setAlerts, testContext: preparedSource, destinationSelectionContext,
        }),
        // Beside the primary, never below the fold: its refusal first, else what it waits on (R19-D5).
        h(ModalCardFooterActions, {
            ...(refusedSave ? { note: refusedSave, noteTone: 'danger' as const, noteTestID: 'health-setup-save-refused' }
                : primaryStatus ? { note: primaryStatus, noteTestID: 'health-setup-primary-status' } : {}),
            // Keep both incomplete edits and the already settled Environment preview with this one open form.
            captureDraft: addingNew ? () => saving ? undefined : JSON.parse(JSON.stringify({
                check: editedDraft,
                ...(editedAlerts ? { alerts: editedAlerts } : {}),
                ...(preparedPreview && props.subject.kind === 'environment' ? { preparedPreview } : {}),
            })) : undefined,
            cancel: { testID: 'health-setup-cancel', disabled: saving,
            onPress: () => { void host.settleEphemeralInput({ kind: 'cancelled' }, { signal: props.signal }); } } },
            offersBoth ? saveChanges('secondary') : null, primary));
}

function HealthCheckSetupSurface(context: RenderContext): ReactElement {
    const launch = readLaunch(context.launchInput);
    if (!launch || launch.draft.subject === undefined) {
        return h(Text, { valueKey: `${K}.unavailable`, fallback: 'Open Add check from a watched service to set up its check.' });
    }
    return h(HealthCheckSetupForm, { subject: launch.draft.subject, existing: launch.draft.checks ?? [],
        newContributedCheck: launch.draft.newContributedCheck,
        sourceOptions: { ...(launch.draft.investigation ? { investigation: launch.draft.investigation } : {}),
            ...(launch.draft.alerts ? { alerts: launch.draft.alerts } : {}), ...(launch.draft.domain ? { domain: launch.draft.domain } : {}) },
        rendererDraft: launch.rendererDraft,
        ...(launch.observerMachineId ? { observerMachineId: launch.observerMachineId } : {}),
        ...(launch.selectedCheckId ? { selectedCheckId: launch.selectedCheckId } : {}), signal: context.signal });
}

export const renderSurface = defineUiSurface(HealthCheckSetupSurface);
