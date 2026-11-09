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
import {
  isTriageSourceConnectedAccountInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import {
  createTriageSourceSettingsSurface,
  type TriageSourceSettingsDraftFieldsPropsV1,
} from '@happier-dev/triage-sources/ui';
import {
  Banner,
  Button,
  Form,
  Stack,
  useExecutePluginAction,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import {
  POSTHOG_ACTION_IDS,
  POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
  POSTHOG_PLUGIN_ID,
  POSTHOG_SOURCE_CONTRIBUTION_ID,
  POSTHOG_SOURCE_DISPLAY_NAME,
} from '../../posthogContracts.js';
import {
  PosthogConfigurationDirectoryResultV1Schema,
  type PosthogConfigurationDirectoryResultV1,
} from '../../connect/configurationContract.js';
import {
  decodePosthogConfiguration,
  encodePosthogConfiguration,
  readPosthogEnvironmentSelection,
  type PosthogWindowPolicy,
} from '../../source/instance.js';

type Organization = Extract<PosthogConfigurationDirectoryResultV1, { kind: 'organizations' }>['rows'][number];

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
  name: string;
  value: WindowDraft;
  onChange: (value: WindowDraft) => void;
  disabled: boolean;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const lower = props.name.toLocaleLowerCase();
  return (
    <Stack gap="small">
      <Form.Select
        label={text('plugins.posthog.ui.settings.windowMode', '{name} window mode', { name: props.name })}
        options={[
          { value: 'relative', label: text('plugins.posthog.ui.settings.relativeWindow', 'Relative {name} window', { name: lower }) },
          { value: 'exact', label: text('plugins.posthog.ui.settings.exactWindow', 'Exact {name} window', { name: lower }) },
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
          label={text('plugins.posthog.ui.settings.windowDays', '{name} window (days)', { name: props.name })}
          value={props.value.relativeDays}
          onChange={(relativeDays) => props.onChange({ ...props.value, relativeDays })}
          keyboardType="numeric"
          disabled={props.disabled}
        />
      ) : (
        <>
          <Form.TextField
            label={text('plugins.posthog.ui.settings.windowStart', '{name} window start (ISO 8601)', { name: props.name })}
            value={props.value.exactFrom}
            onChange={(exactFrom) => props.onChange({ ...props.value, exactFrom })}
            disabled={props.disabled}
          />
          <Form.TextField
            label={text('plugins.posthog.ui.settings.windowEnd', '{name} window end (ISO 8601)', { name: props.name })}
            value={props.value.exactTo}
            onChange={(exactTo) => props.onChange({ ...props.value, exactTo })}
            disabled={props.disabled}
          />
        </>
      )}
    </Stack>
  );
}

/** Organization and window policy remain source-owned; Include and Save are shared. */
function PosthogDraftFields({ draft, busy, onChange }: TriageSourceSettingsDraftFieldsPropsV1): React.ReactElement {
  const text = usePluginTranslation();
  const decoded = decodePosthogConfiguration(draft.configuration);
  const lastValid = React.useRef(decoded);
  if (decoded !== null) lastValid.current = decoded;
  const configuration = lastValid.current;
  const [scanWindow, setScanWindow] = React.useState(() => windowDraft(configuration?.scanWindowPolicy));
  const [detailWindow, setDetailWindow] = React.useState(() => windowDraft(configuration?.detailWindowPolicy));
  const [organizations, setOrganizations] = React.useState<readonly Organization[]>([]);
  const [next, setNext] = React.useState<string | undefined>();
  const [message, setMessage] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const pending = React.useRef<AbortController | null>(null);
  const action = React.useMemo(() => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.configuration }), []);
  const { execute } = useExecutePluginAction(action);
  const binding = draft.binding;
  const loadOrganizations = React.useCallback(async (cursor?: string) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const execution = await execute({ v: 1, kind: 'organizations', binding,
        page: cursor === undefined ? { kind: 'initial' } : { kind: 'continuation', next: cursor },
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const parsed = execution.status === 'success' ? PosthogConfigurationDirectoryResultV1Schema.safeParse(execution.result) : null;
      if (!parsed?.success || parsed.data.kind !== 'organizations') {
        setMessage(text('plugins.posthog.ui.settings.readFailed', 'PostHog could not read this configuration page.'));
        return;
      }
      const page = parsed.data;
      setOrganizations((previous) => cursor === undefined ? page.rows : [...previous, ...page.rows]);
      setNext(page.next);
      setMessage(page.incomplete ? text('plugins.posthog.ui.settings.partial', 'Some provider rows or paging information could not be read; the visible choices remain usable.') : null);
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [binding, execute, text]);
  React.useEffect(() => { void loadOrganizations(); return () => { pending.current?.abort(); pending.current = null; }; }, [loadOrganizations]);
  if (!isTriageSourceConnectedAccountInstanceV1(draft) || configuration === null) {
    return <Banner tone="warning" title={text('plugins.posthog.ui.settings.attention', 'Configuration needs attention')}
      description={text('plugins.posthog.ui.settings.readFailed', 'PostHog could not read this configuration page.')} />;
  }
  const changeWindows = (scan: WindowDraft, detail: WindowDraft) => {
    setScanWindow(scan); setDetailWindow(detail);
    const scanPolicy = readWindowPolicy(scan);
    const detailPolicy = readWindowPolicy(detail);
    // An invalid field remains editable, but the source adapter refuses shared Save.
    const encoded = scanPolicy === null || detailPolicy === null ? null : encodePosthogConfiguration({
      ...configuration, scanWindowPolicy: scanPolicy, detailWindowPolicy: detailPolicy,
    });
    onChange({ ...draft, configuration: { v: 1, token: encoded?.ok ? encoded.token : '' } });
  };
  const options = organizations.some((row) => row.organizationUuid === configuration.organizationUuid)
    ? organizations : [{ organizationUuid: configuration.organizationUuid, displayName: draft.locator?.displayLabel ?? configuration.organizationUuid,
      localInstanceKey: draft.localInstanceKey }, ...organizations];
  return <Stack gap="medium">
    {message === null ? null : <Banner tone="warning" title={text('plugins.posthog.ui.settings.attention', 'Configuration needs attention')} description={message} />}
    <Form.Select label={text('plugins.posthog.ui.settings.organization', 'Organization')}
      options={options.map((row) => ({ value: row.organizationUuid, label: row.displayName }))}
      value={configuration.organizationUuid} disabled={busy}
      onChange={(value) => {
        const organization = organizations.find((row) => row.organizationUuid === value);
        if (organization === undefined || organization.organizationUuid === configuration.organizationUuid) return;
        const encoded = encodePosthogConfiguration({ ...configuration, organizationUuid: organization.organizationUuid,
          include: { kind: 'all' }, environments: [], scopeUnits: [] });
        if (encoded.ok) onChange({ ...draft, localInstanceKey: organization.localInstanceKey,
          configuration: { v: 1, token: encoded.token }, locator: { v: 1, displayLabel: organization.displayName } });
      }} />
    {next === undefined ? null : <Button title="Load more organizations" titleKey="plugins.posthog.ui.settings.loadMoreOrganizations"
      variant="secondary" disabled={busy || loading} busy={loading} onPress={() => { void loadOrganizations(next); }} />}
    <WindowPolicyEditor name={text('plugins.posthog.ui.settings.scan', 'Scan')} value={scanWindow}
      onChange={(value) => changeWindows(value, detailWindow)} disabled={busy} />
    <WindowPolicyEditor name={text('plugins.posthog.ui.settings.detail', 'Detail')} value={detailWindow}
      onChange={(value) => changeWindows(scanWindow, value)} disabled={busy} />
  </Stack>;
}

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: POSTHOG_PLUGIN_ID,
  sourceLocalId: POSTHOG_SOURCE_CONTRIBUTION_ID,
  listInstancesLocalActionId: POSTHOG_ACTION_IDS.listInstances,
  connectedAccountServiceLocalId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
  connectedAccountPurpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
  sourceDisplayName: POSTHOG_SOURCE_DISPLAY_NAME,
  scopeSelection: {
    unitLabel: 'Environments',
    listScopeUnitsLocalActionId: POSTHOG_ACTION_IDS.listScopeUnits,
    readSelection: (draft) => {
      if (!isTriageSourceConnectedAccountInstanceV1(draft)) return null;
      const configuration = decodePosthogConfiguration(draft.configuration);
      return configuration === null ? null : readPosthogEnvironmentSelection(configuration);
    },
    writeSelection: (draft, include, units) => {
      const configuration = decodePosthogConfiguration(draft.configuration);
      if (configuration === null) return null;
      const encoded = encodePosthogConfiguration({ ...configuration, include,
        environments: include.kind === 'all' ? [] : configuration.environments.filter((row) => include.unitIds.includes(row.teamUuid)),
        scopeUnits: include.kind === 'all' ? [] : units,
      });
      return encoded.ok ? { ...draft, configuration: { v: 1, token: encoded.token } } : null;
    },
  },
  DraftFields: PosthogDraftFields,
});
