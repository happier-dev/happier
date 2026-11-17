import { createElement as h, useEffect, useState, type ReactElement } from 'react';
import {
    HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_KINDS_V1, HealthCheckKindCatalogV1ProtocolSchema, createHealthCheckSourceInstanceIdV1,
    HealthCheckHttpConfigV1ProtocolSchema, HealthCheckSetupDraftV1ProtocolSchema, HealthCheckSetupPreviewResultV1ProtocolSchema,
    type HealthCheckSetupPreviewResultV1,
    HealthCheckSetupInputV1ProtocolSchema, HealthCheckTcpConfigV1ProtocolSchema, isHealthCheckLoopbackRefusedV1,
    type HealthCheckKindV1, type HealthCheckKindCatalogV1, type HealthCheckSetupDraftV1, type HealthCheckSetupInputV1, type HealthCheckSubjectV1,
} from '@happier-dev/plugin-sdk';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, resolvePluginLocalizedStringV2Text,
    type PluginJsonSchemaValidator } from '@happier-dev/plugin-sdk/manifest';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    Banner, Button, Column, Columns, Field, Row, Select, SelectionTiles, Stack, Text, TextField,
    defineUiSurface, usePluginHostApi, usePluginTranslation, type IconName,
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
    { id: 'dns', title: 'DNS', subtitle: 'A name resolves to what you expect', icon: 'globe' },
    { id: 'certificate', title: 'Certificate', subtitle: 'Valid, and renewing in time', icon: 'locked' },
    { id: 'heartbeat', title: 'Heartbeat', subtitle: 'Your job pings Happier on schedule', icon: 'waveform' },
    ...monitorKinds.map(id => ({ id, title: monitorDefinitions[id].title, subtitle: monitorDefinitions[id].description, icon: 'waveform' as const })),
];
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

/** The host hands the prebound draft; an observer, when the host names it, decides loopback in place. */
function readLaunch(input: unknown): Readonly<{ draft: HealthCheckSetupDraftV1; observerMachineId?: string }> | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const record = input as Readonly<Record<string, unknown>>;
    const draft = HealthCheckSetupDraftV1ProtocolSchema.safeParse(record.initialInput);
    if (!draft.success || draft.data.subject === undefined) return null;
    const observer = record.observerMachineId;
    return { draft: draft.data, ...(typeof observer === 'string' && observer.length > 0 ? { observerMachineId: observer } : {}) };
}

function configFor(draft: Draft): unknown {
    if (draft.contributedKind) return contributedConfigValue(draft.contributedKind.configSchema, draft.contributedDraft);
    if (draft.kind === 'uptime-kuma') return { monitorId: (draft.monitorId ?? '').trim() };
    if (draft.kind === 'gatus') return { endpointGroup: draft.endpointGroup ?? '', endpointName: draft.endpointName ?? '' };
    const optional = (key: string, value: string) => (value.trim() ? { [key]: value.trim() } : {});
    if (draft.kind === 'tcp') return { host: draft.host.trim(), port: Number(draft.port) };
    if (draft.kind === 'dns') return { hostname: draft.hostname.trim(), recordType: draft.recordType,
        ...optional('expectedAnswer', draft.expectedAnswer) };
    if (draft.kind === 'heartbeat') return { graceMs: draft.graceMs };
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
    observerMachineId?: string; signal: AbortSignal }>): ReactElement {
    const t = usePluginTranslation();
    const host = usePluginHostApi();
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [existing, setExisting] = useState(props.existing);
    const [alertDraft, setAlertDraft] = useState<Readonly<{
        alerts: SourceOptions['alerts']; testContext?: HealthCheckSetupPreviewResultV1['testContext'];
        destinationSelectionContext?: HealthCheckSetupPreviewResultV1['destinationSelectionContext'];
    }>>({ alerts: props.sourceOptions.alerts });
    const { alerts, testContext: preparedSource, destinationSelectionContext } = alertDraft;
    const setAlerts = (next: SourceOptions['alerts']) => setAlertDraft(current => ({ ...current, alerts: next }));
    const [previewUnavailable, setPreviewUnavailable] = useState(false);
    const [previewAttempt, setPreviewAttempt] = useState(0);
    useEffect(() => {
        let retired = false;
        const { domain, ...sourceOptions } = props.sourceOptions;
        void host.executeAction({ pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health/setup' }, {
            v: 1, mode: 'preview', subject: props.subject, ...(props.existing.length ? { checks: props.existing } : {}), ...sourceOptions,
        }, { signal: props.signal }).then(value => {
            const prepared = HealthCheckSetupPreviewResultV1ProtocolSchema.parse(value);
            if (retired || props.signal.aborted) return;
            setAlertDraft(current => ({ alerts: current.alerts ?? prepared.sourceConfig.alerts,
                destinationSelectionContext: prepared.destinationSelectionContext,
                ...(current.alerts === props.sourceOptions.alerts ? { testContext: prepared.testContext } : {}) }));
            setExisting(prepared.sourceConfig.checks ?? props.existing);
            setInvestigation(current => current ?? prepared.sourceConfig.investigation);
            setPreviewUnavailable(false);
        }).catch(() => { if (!retired && !props.signal.aborted) setPreviewUnavailable(true); });
        return () => { retired = true; };
    }, [host, props.signal, props.subject, props.existing, props.sourceOptions, previewAttempt]);
    const [investigation, setInvestigation] = useState<Readonly<{ mode: 'inbox' | 'auto_start'; configuredActionId?: string }> | undefined>(props.sourceOptions.investigation);
    const investigationMode = investigation?.mode ?? 'inbox';
    const configuredActionId = investigation?.configuredActionId ?? '';
    const [saving, setSaving] = useState(false);
    const [refusedSave, setRefusedSave] = useState(false);
    const [catalog, setCatalog] = useState<HealthCheckKindCatalogV1 | null>(null);
    const [loadingKinds, setLoadingKinds] = useState(false);
    const [kindsUnavailable, setKindsUnavailable] = useState(false);
    const nativeDomain = props.sourceOptions.domain !== undefined && !draft.contributedKind && !isMonitorKind(draft.kind);
    const set = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setRefusedSave(false); };
    const selectContributed = (kind: HealthCheckKindCatalogV1[number]) => set({ contributedKind: kind,
        contributedValidator: compilePluginJsonSchema(kind.configSchema), contributedDraft: contributedConfigDraft(kind.configSchema) });
    const issues = fieldIssues(draft, t);
    const candidate = buildHealthCheckSetupInput(props.subject, existing, draft, { ...props.sourceOptions,
        ...(alerts === undefined ? {} : { alerts }),
        investigation: investigationMode === 'auto_start'
            ? { mode: 'auto_start', configuredActionId: configuredActionId.trim() } : { mode: 'inbox' } });
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
    const savedCandidate = HealthCheckSetupInputV1ProtocolSchema.safeParse({ v: 1, subject: props.subject, checks: existing,
        alerts, investigation: investigationMode === 'auto_start'
            ? { mode: 'auto_start', configuredActionId: configuredActionId.trim() } : { mode: 'inbox' } });
    const canAdd = alerts !== undefined && candidate.success && contributedValid && monitorValid && loopback?.refused !== true && !saving;
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
            schema: draft.contributedKind.configSchema, draft: draft.contributedDraft, onChange: next => set({ contributedDraft: next }) }),
        columns('cadence', 2, ...cadence),
    ] : monitorKind ? [
        h(Text, { key: 'monitor-about', tone: 'secondary', value: t(`${K}.monitor.about`,
            'Happier uses this monitor’s updates. After saving, reveal its address here and set the provider to send JSON with POST.') }),
        ...(monitorKind === 'uptime-kuma' ? [text(t(`${K}.monitorId`, 'Monitor ID'), draft.monitorId ?? '', value => set({ monitorId: value }), {
            numeric: true, testID: 'health-setup-monitor-id' })] : [
            text(t(`${K}.endpointGroup`, 'Endpoint group'), draft.endpointGroup ?? '', value => set({ endpointGroup: value }), {
                required: false, testID: 'health-setup-endpoint-group' }),
            text(t(`${K}.endpointName`, 'Endpoint name'), draft.endpointName ?? '', value => set({ endpointName: value }), {
                testID: 'health-setup-endpoint-name' }),
            h(Text, { key: 'gatus-template', tone: 'secondary', value: t(`${K}.monitor.gatusTemplate`,
                'In Gatus, use the custom POST body: {"endpointGroup":"[ENDPOINT_GROUP]","endpointName":"[ENDPOINT_NAME]","status":"[ALERT_TRIGGERED_OR_RESOLVED]"}. Set Content-Type to application/json.') }),
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

    return h(Stack, { gap: 'large', testID: 'health-setup-form' },
        previewUnavailable ? h(Stack, {}, h(Text, { value: t(`${K}.previewUnavailable`, 'Alert defaults could not be loaded. Your entries are kept here.') }),
            h(Button, { title: t(`${K}.previewRetry`, 'Retry alert defaults'), onPress: () => setPreviewAttempt(value => value + 1) })) : null,
        h(SavedHealthAlertControls, { alerts, onChange: setAlerts, testContext: preparedSource, destinationSelectionContext }),
        h(SavedHeartbeatControls, { subject: props.subject, checks: existing, signal: props.signal }),
        h(SavedHealthCheckControls, { subject: props.subject, checks: existing, signal: props.signal }),
        ...existing.flatMap(check => {
            if (!isMonitorCheck(check)) return [];
            const kind = check.kind.localId;
            const parsed = monitorDefinitions[kind].configSchema.safeParse(check.config);
            if (!parsed.success || !parsed.data.webhookEndpointId) return [];
            return [h(CapabilityEndpointAddressControls, { key: `${createHealthCheckSourceInstanceIdV1(props.subject)}:${check.checkId}:${parsed.data.webhookEndpointId}`,
                webhookEndpointId: parsed.data.webhookEndpointId, signal: props.signal, title: `${monitorDefinitions[kind].title}: ${check.checkId}` })];
        }),
        h(SelectionTiles<SetupKind>, { accessibilityLabel: t(`${K}.kind`, 'Kind of check'), testID: 'health-setup-kind',
            value: draft.contributedKind ? null : draft.kind,
            onChange: (kind: SetupKind) => set({ kind, contributedKind: undefined, contributedValidator: undefined }), maximumColumns: 3, minimumColumns: 2,
            options: KINDS.filter(kind => !props.sourceOptions.domain || kind.id === 'http' || isMonitorKind(kind.id))
                .map(kind => ({ id: kind.id, icon: kind.icon, title: kind.id === 'http' && props.sourceOptions.domain ? 'HTTP and certificate' : kind.title,
                ...(kind.id === 'http' && props.sourceOptions.domain ? {} : { titleKey: `${K}.kind.${kind.id}` }),
                subtitle: kind.subtitle, subtitleKey: `${K}.kind.${kind.id}.subtitle` })) }),
        h(Button, { title: t(`${K}.more`, 'More checks'), busy: loadingKinds, disabled: loadingKinds,
            onPress: async () => {
                setLoadingKinds(true);
                setKindsUnavailable(false);
                try {
                    const kinds = HealthCheckKindCatalogV1ProtocolSchema.parse(await host.executeAction(
                        { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: HEALTH_KINDS_ACTION_ID }, {}, { signal: props.signal }))
                        .filter(kind => kind.pluginId !== HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1
                            || (!HEALTH_CHECK_KINDS_V1.some(native => native === kind.id) && !isMonitorKind(kind.id)));
                    if (!props.signal.aborted) {
                        setCatalog(kinds);
                        if (kinds[0]) selectContributed(kinds[0]);
                    }
                } catch { if (!props.signal.aborted) setKindsUnavailable(true); }
                finally { if (!props.signal.aborted) setLoadingKinds(false); }
            } }),
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
        h(SelectionTiles<'inbox' | 'auto_start'>, { accessibilityLabel: t(`${K}.investigation`, 'When a check needs attention'),
            value: investigationMode, onChange: mode => { setInvestigation({ mode, configuredActionId }); setRefusedSave(false); }, maximumColumns: 2,
            options: [
                { id: 'inbox', title: t(`${K}.investigation.inbox`, 'Show in Inbox'),
                    subtitle: t(`${K}.investigation.inbox.description`, 'Investigate when you choose.') },
                { id: 'auto_start', title: t(`${K}.investigation.automatic`, 'Start investigation'),
                    subtitle: t(`${K}.investigation.automatic.description`, 'Use a configured Action when a new alert opens.') },
            ] }),
        investigationMode === 'auto_start' ? text(t(`${K}.investigation.action`, 'Configured investigation'), configuredActionId,
            value => { setInvestigation({ mode: 'auto_start', configuredActionId: value }); setRefusedSave(false); }, { testID: 'health-setup-investigation-action',
                description: t(`${K}.investigation.action.description`,
                    'Choose an existing investigate Action from PRs & Issues. Its saved Machine, workspace and Agent choices are used.') }) : null,
        refusedSave ? h(Text, { tone: 'danger', value: t(`${K}.saveRefused`, 'This check can’t be added right now. Your entries are kept here.') }) : null,
        existing.length > 0 || props.subject.kind === 'environment' ? h(Button, { title: t(`${K}.saveChanges`, 'Save changes'), variant: 'secondary',
            disabled: alerts === undefined || !savedCandidate.success || saving, busy: saving, testID: 'health-setup-save',
            onPress: async () => {
                if (!savedCandidate.success) return;
                setSaving(true);
                try {
                    await host.settleEphemeralInput({ kind: 'completed', input: savedCandidate.data }, { signal: props.signal });
                } catch { setRefusedSave(true); }
                finally { setSaving(false); }
            } }) : null,
        h(Row, { justify: 'flex-end' }, h(Button, { title: nativeDomain ? t(`${K}.enable`, 'Enable checks') : t(`${K}.add`, 'Add check'), variant: 'primary', disabled: !canAdd,
            busy: saving, testID: 'health-setup-add',
            onPress: async () => {
                if (!candidate.success) return;
                setSaving(true);
                try {
                    await host.settleEphemeralInput({ kind: 'completed', input: candidate.data }, { signal: props.signal });
                } catch {
                    setRefusedSave(true);
                } finally {
                    setSaving(false);
                }
            } })));
}

function HealthCheckSetupSurface(context: RenderContext): ReactElement {
    const launch = readLaunch(context.launchInput);
    if (!launch || launch.draft.subject === undefined) {
        return h(Text, { valueKey: `${K}.unavailable`, fallback: 'Open Add check from a watched service to set up its check.' });
    }
    return h(HealthCheckSetupForm, { subject: launch.draft.subject, existing: launch.draft.checks ?? [],
        sourceOptions: { ...(launch.draft.investigation ? { investigation: launch.draft.investigation } : {}),
            ...(launch.draft.alerts ? { alerts: launch.draft.alerts } : {}), ...(launch.draft.domain ? { domain: launch.draft.domain } : {}) },
        ...(launch.observerMachineId ? { observerMachineId: launch.observerMachineId } : {}), signal: context.signal });
}

export const renderSurface = defineUiSurface(HealthCheckSetupSurface);
