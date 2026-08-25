/**
 * The PostHog PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. What PostHog contributes is the three facts no shared page
 * can derive: which plugin is asking, which of its Actions enumerates what it
 * can reach, and what to call this source in a sentence.
 *
 * This file is that contribution AND the module the manifest's
 * `posthog-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import * as React from 'react';
import type { TriageSourceInstanceDraftV1 } from '@happier-dev/triage-protocol/v1';
import {
  createTriageSourceSettingsSurface,
  type TriageSourceSettingsDraftEditorPropsV1,
} from '@happier-dev/triage-sources';
import {
  Banner,
  Button,
  Form,
  Heading,
  Row,
  Stack,
  Text,
  useExecutePluginAction,
} from '@happier-dev/plugin-ui';

import {
  POSTHOG_ACTION_IDS,
  POSTHOG_PLUGIN_ID,
  POSTHOG_SOURCE_DISPLAY_NAME,
} from '../../posthogContracts.js';
import {
  PosthogConfigurationDirectoryResultV1Schema,
  type PosthogConfigurationDirectoryInputV1,
  type PosthogConfigurationDirectoryResultV1,
} from '../../connect/configurationContract.js';
import { PosthogCapabilityProbeResultV1Schema } from '../../connect/capabilityProbe.js';
import {
  decodePosthogConfiguration,
  encodePosthogConfiguration,
  type PosthogConfiguredEnvironment,
  type PosthogWindowPolicy,
} from '../../source/instance.js';
import { preflightPosthogEnvironmentSelection } from '../../connect/configuration.js';

type Organization = Extract<PosthogConfigurationDirectoryResultV1, { kind: 'organizations' }>['rows'][number];
type Environment = Extract<PosthogConfigurationDirectoryResultV1, { kind: 'environments' }>['rows'][number];
type FormSelectValue = Parameters<React.ComponentProps<typeof Form.Select>['onChange']>[0];

const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;

type WindowDraft = Readonly<{
  mode: PosthogWindowPolicy['kind'];
  relativeDays: string;
  exactFrom: string;
  exactTo: string;
}>;

function windowDraft(policy: PosthogWindowPolicy | undefined): WindowDraft {
  if (policy?.kind === 'exact') {
    return {
      mode: 'exact',
      relativeDays: '30',
      exactFrom: policy.from,
      exactTo: policy.to,
    };
  }
  const durationMs = policy?.durationMs ?? 30 * MILLIS_PER_DAY;
  const exactTo = new Date();
  return {
    mode: 'relative',
    relativeDays: String(durationMs / MILLIS_PER_DAY),
    exactFrom: new Date(exactTo.getTime() - durationMs).toISOString(),
    exactTo: exactTo.toISOString(),
  };
}

function readWindowPolicy(draft: WindowDraft): PosthogWindowPolicy | null {
  if (draft.mode === 'exact') {
    return Number.isNaN(Date.parse(draft.exactFrom)) || Number.isNaN(Date.parse(draft.exactTo))
      ? null
      : { kind: 'exact', from: draft.exactFrom, to: draft.exactTo };
  }
  const days = Number(draft.relativeDays);
  return Number.isSafeInteger(days) && days > 0
    ? { kind: 'relative', durationMs: days * MILLIS_PER_DAY }
    : null;
}

function WindowPolicyEditor(props: Readonly<{
  name: 'Scan' | 'Detail';
  value: WindowDraft;
  onChange: (value: WindowDraft) => void;
  disabled: boolean;
}>): React.ReactElement {
  const lower = props.name.toLowerCase();
  return (
    <Stack gap="small">
      <Form.Select
        label={`${props.name} window mode`}
        options={[
          { value: 'relative', label: `Relative ${lower} window` },
          { value: 'exact', label: `Exact ${lower} window` },
        ]}
        value={props.value.mode}
        onChange={(next) => {
          if (next === 'relative' || next === 'exact') {
            props.onChange({ ...props.value, mode: next });
          }
        }}
        disabled={props.disabled}
      />
      {props.value.mode === 'relative' ? (
        <Form.TextField
          label={`${props.name} window (days)`}
          value={props.value.relativeDays}
          onChange={(relativeDays) => props.onChange({ ...props.value, relativeDays })}
          keyboardType="numeric"
          disabled={props.disabled}
        />
      ) : (
        <>
          <Form.TextField
            label={`${props.name} window start (ISO 8601)`}
            value={props.value.exactFrom}
            onChange={(exactFrom) => props.onChange({ ...props.value, exactFrom })}
            disabled={props.disabled}
          />
          <Form.TextField
            label={`${props.name} window end (ISO 8601)`}
            value={props.value.exactTo}
            onChange={(exactTo) => props.onChange({ ...props.value, exactTo })}
            disabled={props.disabled}
          />
        </>
      )}
    </Stack>
  );
}

function mergeEnvironments(
  first: readonly Environment[],
  second: readonly Environment[],
): readonly Environment[] {
  const byUuid = new Map(first.map((environment) => [environment.teamUuid, environment]));
  for (const environment of second) byUuid.set(environment.teamUuid, environment);
  return [...byUuid.values()];
}

function PosthogDraftEditor({
  draft,
  busy,
  onSubmit,
  onCancel,
}: TriageSourceSettingsDraftEditorPropsV1): React.ReactElement {
  const action = React.useMemo(() => ({
    pluginId: POSTHOG_PLUGIN_ID,
    localId: POSTHOG_ACTION_IDS.configuration,
  }), []);
  const directory = useExecutePluginAction(action);
  const capability = useExecutePluginAction(React.useMemo(() => ({
    pluginId: POSTHOG_PLUGIN_ID,
    localId: POSTHOG_ACTION_IDS.capability,
  }), []));
  const decoded = React.useMemo(() => decodePosthogConfiguration(draft.configuration), [draft]);
  const [organizations, setOrganizations] = React.useState<readonly Organization[]>([]);
  const [organizationNext, setOrganizationNext] = React.useState<string | null>(null);
  const [organizationUuid, setOrganizationUuid] = React.useState(decoded?.organizationUuid ?? '');
  const [environments, setEnvironments] = React.useState<readonly Environment[]>(
    decoded?.environments ?? [],
  );
  const [environmentNext, setEnvironmentNext] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<readonly string[]>(
    decoded?.environments.map((environment) => environment.teamUuid) ?? [],
  );
  const [scanWindow, setScanWindow] = React.useState(() => windowDraft(decoded?.scanWindowPolicy));
  const [detailWindow, setDetailWindow] = React.useState(() => windowDraft(decoded?.detailWindowPolicy));
  const [message, setMessage] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const mountedGeneration = React.useRef(0);
  const pendingCapability = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    mountedGeneration.current += 1;
    return () => {
      mountedGeneration.current += 1;
      pendingCapability.current?.abort();
      pendingCapability.current = null;
    };
  }, []);

  const execute = directory.execute;
  const readPage = React.useCallback(async (
    input: PosthogConfigurationDirectoryInputV1,
  ): Promise<PosthogConfigurationDirectoryResultV1 | null> => {
    setLoading(true);
    const execution = await execute(input);
    setLoading(false);
    if (execution.status !== 'success') {
      setMessage('PostHog could not read this configuration page.');
      return null;
    }
    const parsed = PosthogConfigurationDirectoryResultV1Schema.safeParse(execution.result);
    if (!parsed.success || parsed.data.kind === 'unavailable') {
      setMessage('PostHog could not read this configuration page.');
      return null;
    }
    setMessage(parsed.data.incomplete === true
      ? 'Some provider rows or paging information could not be read; the visible choices remain usable.'
      : null);
    return parsed.data;
  }, [execute]);

  const loadOrganizations = React.useCallback(async (next: string | null) => {
    const result = await readPage({
      v: 1,
      kind: 'organizations',
      binding: draft.binding,
      page: next === null ? { kind: 'initial' } : { kind: 'continuation', next },
    });
    if (result?.kind !== 'organizations') return;
    setOrganizations((previous) => next === null ? result.rows : [...previous, ...result.rows]);
    setOrganizationNext(result.next ?? null);
  }, [draft.binding, readPage]);

  const loadEnvironments = React.useCallback(async (uuid: string, next: string | null) => {
    if (uuid.length === 0) return;
    const result = await readPage({
      v: 1,
      kind: 'environments',
      binding: draft.binding,
      organizationUuid: uuid,
      page: next === null ? { kind: 'initial' } : { kind: 'continuation', next },
    });
    if (result?.kind !== 'environments' || result.organizationUuid !== uuid) return;
    setEnvironments((previous) => mergeEnvironments(previous, result.rows));
    setEnvironmentNext(result.next ?? null);
  }, [draft.binding, readPage]);

  React.useEffect(() => {
    void loadOrganizations(null);
  }, [loadOrganizations]);

  React.useEffect(() => {
    if (organizationUuid.length > 0) void loadEnvironments(organizationUuid, null);
  }, [loadEnvironments, organizationUuid]);

  const selectedEnvironments = React.useMemo(() => environments
    .filter((environment) => selected.includes(environment.teamUuid))
    .map((environment): PosthogConfiguredEnvironment => ({
      teamPathId: environment.teamPathId,
      teamUuid: environment.teamUuid,
      ...(environment.parentProjectId === undefined ? {} : { parentProjectId: environment.parentProjectId }),
      displayName: environment.displayName,
    })), [environments, selected]);

  const encodeDraft = React.useCallback((environmentSet: readonly PosthogConfiguredEnvironment[]) => {
    const scanWindowPolicy = readWindowPolicy(scanWindow);
    const detailWindowPolicy = readWindowPolicy(detailWindow);
    if (scanWindowPolicy === null || detailWindowPolicy === null) {
      return { ok: false as const, message: 'Use positive whole days or valid ISO 8601 exact window endpoints.' };
    }
    const organization = organizations.find((entry) => entry.organizationUuid === organizationUuid);
    if (organization === undefined) {
      return { ok: false as const, message: 'Choose a PostHog organization.' };
    }
    const encoded = encodePosthogConfiguration({
      v: 1,
      organizationUuid,
      environments: environmentSet,
      scanWindowPolicy,
      detailWindowPolicy,
    });
    if (!encoded.ok) {
      return {
        ok: false as const,
        message: encoded.reason === 'tokenTooLarge'
          ? `This environment selection needs ${String(encoded.utf8Bytes)} UTF-8 bytes and cannot fit one source configuration.`
          : 'Choose at least one valid PostHog environment.',
      };
    }
    return {
      ok: true as const,
      draft: {
        ...draft,
        localInstanceKey: organization.localInstanceKey,
        configuration: { v: 1 as const, token: encoded.token },
        locator: { v: 1 as const, displayLabel: organization.displayName },
      } satisfies TriageSourceInstanceDraftV1,
    };
  }, [detailWindow, draft, organizationUuid, organizations, scanWindow]);

  const changeSelection = React.useCallback((value: FormSelectValue) => {
    const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    const nextIds = values.filter((item): item is string => typeof item === 'string');
    const nextRows = environments.filter((environment) => nextIds.includes(environment.teamUuid));
    const proposedRows = nextRows.map((environment) => ({
      teamPathId: environment.teamPathId,
      teamUuid: environment.teamUuid,
      ...(environment.parentProjectId === undefined ? {} : { parentProjectId: environment.parentProjectId }),
      displayName: environment.displayName,
    }));
    const scanWindowPolicy = readWindowPolicy(scanWindow);
    const detailWindowPolicy = readWindowPolicy(detailWindow);
    if (scanWindowPolicy === null || detailWindowPolicy === null) {
      setMessage('Use positive whole days or valid ISO 8601 exact window endpoints.');
      return;
    }
    const preflight = preflightPosthogEnvironmentSelection(selectedEnvironments, proposedRows, {
      organizationUuid,
      scanWindowPolicy,
      detailWindowPolicy,
    });
    if (!preflight.encoding.ok && preflight.encoding.reason === 'tokenTooLarge') {
      setMessage(`This environment selection needs ${String(preflight.encoding.utf8Bytes)} UTF-8 bytes and cannot fit one source configuration.`);
      return;
    }
    setSelected(nextIds);
    setMessage(null);
  }, [detailWindow, environments, organizationUuid, scanWindow, selectedEnvironments]);

  return (
    <Stack gap="medium">
      <Heading level={3} value="Choose PostHog environments" />
      <Text value="Choose an organization, any non-empty subset of its environments, and the scan and detail windows." />
      {message === null ? null : <Banner tone="warning" title="Configuration needs attention" description={message} />}
      <Form.Select
        label="Organization"
        options={organizations.map((organization) => ({
          value: organization.organizationUuid,
          label: organization.displayName,
        }))}
        value={organizationUuid}
        onChange={(value) => {
          if (typeof value !== 'string') return;
          setOrganizationUuid(value);
          setSelected([]);
          setEnvironments([]);
          setEnvironmentNext(null);
        }}
        disabled={busy || loading}
      />
      {organizationNext === null ? null : (
        <Button
          title="Load more organizations"
          variant="secondary"
          busy={loading}
          disabled={busy || loading}
          onPress={() => { void loadOrganizations(organizationNext); }}
        />
      )}
      <Form.Select
        label="Environments"
        multiple
        minimumSelections={1}
        options={environments.map((environment) => ({
          value: environment.teamUuid,
          label: environment.displayName,
        }))}
        value={selected}
        onChange={changeSelection}
        disabled={busy || loading}
      />
      {environmentNext === null ? null : (
        <Button
          title="Load more environments"
          variant="secondary"
          busy={loading}
          disabled={busy || loading}
          onPress={() => { void loadEnvironments(organizationUuid, environmentNext); }}
        />
      )}
      <WindowPolicyEditor name="Scan" value={scanWindow} onChange={setScanWindow} disabled={busy} />
      <WindowPolicyEditor name="Detail" value={detailWindow} onChange={setDetailWindow} disabled={busy} />
      <Row gap="small">
        <Button
          title="Save PostHog configuration"
          variant="primary"
          busy={busy}
          disabled={busy || loading}
          onPress={() => {
            const prospective = encodeDraft(selectedEnvironments);
            if (!prospective.ok) {
              setMessage(prospective.message);
              return;
            }
            void (async () => {
              pendingCapability.current?.abort();
              const controller = new AbortController();
              pendingCapability.current = controller;
              const generation = mountedGeneration.current;
              const isCurrent = () => (
                !controller.signal.aborted
                && pendingCapability.current === controller
                && mountedGeneration.current === generation
              );
              setLoading(true);
              const execution = await capability.execute(
                { v: 1, draft: prospective.draft },
                { signal: controller.signal },
              );
              const result = execution.status === 'success'
                ? PosthogCapabilityProbeResultV1Schema.safeParse(execution.result)
                : null;
              if (!isCurrent()) return;
              setLoading(false);
              if (execution.status !== 'success') {
                setMessage('PostHog could not verify Error Tracking access for this selection.');
                return;
              }
              if (result === null || !result.success || result.data.kind !== 'available') {
                setMessage('PostHog Error Tracking is unavailable for this selection.');
                return;
              }
              await onSubmit(prospective.draft);
              if (pendingCapability.current === controller) pendingCapability.current = null;
            })();
          }}
        />
        <Button title="Cancel" variant="secondary" disabled={busy} onPress={onCancel} />
      </Row>
    </Stack>
  );
}

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: POSTHOG_PLUGIN_ID,
  listInstancesLocalActionId: POSTHOG_ACTION_IDS.listInstances,
  sourceDisplayName: POSTHOG_SOURCE_DISPLAY_NAME,
  DraftEditor: PosthogDraftEditor,
});
