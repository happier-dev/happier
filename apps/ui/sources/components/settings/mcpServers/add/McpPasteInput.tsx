import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  McpImportMovedSecretV1Schema,
} from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CapabilityAddFooter, type CapabilityAddInputContext } from '@/components/capabilities/add/CapabilityAddModal';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import {
  WhereItsOnControl,
} from '@/components/capabilities/where/WhereItsOnControl';
import { whereItsOnReach } from '@/components/capabilities/where/whereItsOnPresentation';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import {
  projectReachOnMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';

import {
  buildMcpPasteValues,
  buildMcpPastePreviewModel,
  countOpenMcpPasteValues,
  countOpenMcpPasteServerValues,
  EMPTY_MCP_PASTE_ANSWERS,
  createMcpPasteDraftStore,
  withMcpPasteServerTransport,
  type McpPasteDraftState,
  type McpPasteDraftStore,
  type McpPasteServerModel,
} from './mcpAddPaste';
import { McpAddNextSteps, McpAddSignInItem } from './McpAddDetail';
import { McpPasteServer } from './McpPasteServer';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import type { McpAddPlaces } from './useMcpAddPlaces';

type Execution = ReturnType<typeof useMountedActionExecution>;

/** A config-document link is read by the host; everything else is the pasted text itself. */
function importSource(text: string) {
  const trimmed = text.trim();
  if (/^https:\/\/\S+$/u.test(trimmed) && !trimmed.includes('install='))
    return { kind: 'link' as const, url: trimmed };
  return { kind: 'paste' as const, text };
}

type DraftOptions = Readonly<{
    initialText?: string;
    execution: Execution;
    scope: AccountSettingsScope | null;
    writable: boolean;
    reloadCatalog: () => Promise<void>;
}>;

const initialDraft = (text: string): McpPasteDraftState => ({
  text, preview: null, previewText: null, answers: EMPTY_MCP_PASTE_ANSWERS,
  retained: {}, rules: whereItsOnReach.createDefault('mcp_server'), where: undefined,
  busy: false, error: null, added: false,
});

/** The modal retains only the draft and mutation; hidden Paste has no readers or preview timer. */
export type McpPasteDraft = Readonly<{
  store: McpPasteDraftStore;
  create: () => Promise<readonly string[] | null>;
  retryPreview: () => void;
  reset: () => void;
  isDirty: () => boolean;
  current: boolean;
}>;

export function useMcpPasteDraft(options: DraftOptions): McpPasteDraft {
  const [store] = React.useState(() => createMcpPasteDraftStore(initialDraft(options.initialText ?? '')));
  const latest = React.useRef(options);
  latest.current = options;
  const capturedScope = React.useRef(options.scope);
  if (!capturedScope.current && options.scope) capturedScope.current = options.scope;
  const isCurrent = React.useCallback(() => capturedScope.current !== null
    && areAccountSettingsScopesEqual(capturedScope.current, latest.current.scope), []);
  const create = React.useCallback(async (): Promise<readonly string[] | null> => {
    const current = store.getSnapshot();
    const props = latest.current;
    const model = current.preview ? buildMcpPastePreviewModel(current.preview) : null;
    if (!isCurrent() || !props.writable || current.busy || current.added || !model || model.servers.length === 0
      || current.previewText !== current.text || countOpenMcpPasteValues(model, current.answers) > 0) return null;
    const updateDocument = (change: (state: McpPasteDraftState) => McpPasteDraftState) =>
      store.update(state => state.text === current.text ? change(state) : state);
    store.update(state => ({ ...state, busy: true, error: null }));
    try {
      const values = buildMcpPasteValues(model, current.answers, current.retained);
      const result = await props.execution.execute('mcp.servers.import', {
        dryRun: false,
        source: importSource(current.text),
        values,
        ...(current.where ? { where: current.where } : {}),
      });
      if (!result.ok) {
        // Keys saved before the failure are reused by the retry: never saved twice.
        const moved = Array.isArray(
          (result.details as { movedSecrets?: unknown } | undefined)
            ?.movedSecrets,
        )
          ? (result.details as { movedSecrets: unknown[] }).movedSecrets
          : [];
        for (const entry of moved) {
          const parsed = McpImportMovedSecretV1Schema.safeParse(entry);
          if (parsed.success)
            updateDocument(state => ({ ...state, retained: {
              ...state.retained,
              [parsed.data.inputId]: {
                t: 'savedSecret',
                secretId: parsed.data.secretRef,
              },
            } }));
        }
        updateDocument(state => ({ ...state, error: result.errorCode ?? t('capabilities.mcpAdd.paste.addFailed') }));
        return null;
      }
      const committed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[
        'mcp.servers.import'
      ].safeParse(result.result);
      if (
        !committed.success ||
        !('ok' in committed.data) ||
        !committed.data.ok
      ) {
        updateDocument(state => ({ ...state, error: t('capabilities.mcpAdd.paste.addFailed') }));
        return null;
      }
      updateDocument(state => ({ ...state, added: true }));
      if (props.scope) void refreshSavedSecretCatalog(props.scope).catch(() => undefined);
      await props.reloadCatalog().catch(() => undefined);
      if (!isCurrent() || !props.execution.isCurrent() || store.getSnapshot().text !== current.text) return null;
      return committed.data.serverIds;
    } catch (failure) {
      if (!isTeamActionApprovalPendingError(failure))
        updateDocument(state => ({ ...state, error: failure instanceof Error && failure.message
            ? failure.message
            : t('capabilities.mcpAdd.paste.addFailed') }));
      return null;
    } finally {
      store.update(state => ({ ...state, busy: false }));
    }
  }, [store, isCurrent]);
  const reset = React.useCallback(() => store.update(() => initialDraft('')), [store]);
  const retryPreview = React.useCallback(() => {
    if (!isCurrent()) return;
    store.update(state => state.busy || state.added || (state.previewText === null && state.error === null)
      ? state : { ...state, previewText: null, error: null });
  }, [isCurrent, store]);
  const isDirty = React.useCallback(() => {
    const state = store.getSnapshot();
    return !state.added && state.text.trim().length > 0;
  }, [store]);
  return React.useMemo(() => ({ store, create, reset, retryPreview, isDirty, current: isCurrent() }), [store, create, reset, retryPreview, isDirty, options.scope, isCurrent]);
}

export function useMcpPasteDirty(draft: McpPasteDraft): boolean {
  return React.useSyncExternalStore(draft.store.subscribe, draft.isDirty, draft.isDirty);
}

/** Paste uses the shared results list and one selected field renderer, with one batch operation. */
export function McpPasteInput(props: Readonly<{
  testID: string;
  ctx: CapabilityAddInputContext;
  draft: McpPasteDraft;
  execution: Execution;
  scope: AccountSettingsScope | null;
  places: McpAddPlaces;
  writable: boolean;
  onAdded: (serverIds: readonly string[]) => void | Promise<void>;
  onDone: () => void | Promise<void>;
}>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { execute, approval } = props.execution;
  const { store } = props.draft;
  const { text, preview, previewText, answers, rules, busy, error, added } = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const setText = React.useCallback((next: string) => store.update(state => state.text === next ? state : ({
    // A changed document is a new import, not a retry of the earlier Secret receipt.
    ...state, text: next, retained: {}, added: false, error: null, ...(!next.trim() ? { preview: null, previewText: null } : {}),
  })), [store]);
  const catalog = useSavedSecretCatalog({ scope: props.draft.current ? props.scope : null });
  const secrets = React.useMemo(() => [...catalog.materializedSecrets], [catalog.materializedSecrets]);
  // Existing input-triggered preview cadence; cleanup withdraws the departed input's result.
  React.useEffect(() => {
    if (!props.draft.current || !props.execution.ready || !text.trim() || previewText === text) return;
    let live = true;
    const timer = setTimeout(() => {
      void execute('mcp.servers.import', { dryRun: true, source: importSource(text) }).then(result => {
        if (!live) return;
        if (!result.ok) {
          store.update(state => ({ ...state, previewText: text, preview: null, error: result.errorCode ?? result.error }));
          return;
        }
        const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.import'].safeParse(result.result);
        const admitted = parsed?.success && 'servers' in parsed.data ? parsed.data : null;
        store.update(state => ({ ...state, previewText: text, preview: admitted,
          error: admitted ? null : t('capabilities.mcpAdd.paste.addFailed') }));
      }).catch(failure => {
        if (live && !isTeamActionApprovalPendingError(failure)) store.update(state => ({ ...state, previewText: text, preview: null,
          error: failure instanceof Error && failure.message ? failure.message : t('capabilities.mcpAdd.paste.addFailed') }));
      });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [execute, text, previewText, store, props.draft.current, props.execution.ready]);
  const model = React.useMemo(() => preview ? buildMcpPastePreviewModel(preview) : null, [preview]);
  const servers = model?.servers ?? NO_SERVERS;
  const open = model ? countOpenMcpPasteValues(model, answers) : 0;
  const disabledReason = !props.writable || previewText !== text ? t('capabilities.mcpAdd.paste.addFailed')
    : open > 0 ? t('capabilities.mcpAdd.paste.stillNeeded', { count: open }) : null;
  const setRow = React.useCallback((inputId: string, value: ValueRefV1) => store.update(state => sameStrictJsonValue(state.answers.rows[inputId], value)
    ? state : ({ ...state, answers: { ...state.answers, rows: { ...state.answers.rows, [inputId]: value } } })), [store]);
  const setField = React.useCallback((inputId: string, value: string) => store.update(state => state.answers.fields[inputId] === value
    ? state : ({ ...state, answers: { ...state.answers, fields: { ...state.answers.fields, [inputId]: value } } })), [store]);
  const flipTransport = React.useCallback((name: string, transport: 'http' | 'sse') => {
    const next = withMcpPasteServerTransport(store.getSnapshot().text, name, transport);
    if (next !== null) setText(next);
  }, [store, setText]);
  const projection = React.useMemo(() => projectReachOnMachines(rules, props.places.machines as readonly ReachMachine[], undefined, props.places.workspaceRefs),
    [rules, props.places.machines, props.places.workspaceRefs]);

  const jsonPasted = /^\s*\{/u.test(text);
  const unreadable = preview?.errors.find((code) => !code.includes(':')) ?? null;

  const anatomy = React.useMemo(() => buildCapabilityCollectionAnatomy<McpPasteServerModel>({
    title: server => server.title,
    // Line 2 says where it runs and what it still needs, as the found rows do in lab `n:paste`.
    description: server => {
      const missing = countOpenMcpPasteServerValues(server, answers);
      const where = server.transport === 'stdio' ? t('capabilities.mcpAdd.paste.local') : t('capabilities.mcpAdd.paste.remote');
      return missing > 0 ? `${where} · ${t('capabilities.mcpAdd.paste.stillNeeded', { count: missing })}` : where;
    },
    mark: server => <HappierBrandMark brand={{ displayName: server.title }} pixelSize={20} externallyLabelled />,
    facts: server => ({ presentation: 'row', extra: [server.transport === 'stdio'
      ? t('capabilities.mcpAdd.paste.local') : t('capabilities.mcpAdd.paste.remote')] }),
    accessibilityLabel: server => server.title,
    testID: server => `${props.testID}.row.${server.name}`,
  }), [props.testID, answers]);

  if (!props.draft.current) return <Text variant="body">{t('capabilities.mcpAdd.paste.addFailed')}</Text>;

  const pasteField = (
        <View style={styles.paste}>
          <Text variant="body" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.mcpAdd.paste.empty')}
          </Text>
          <FieldTextInput
            testID={`${props.testID}.input`}
            value={text}
            onChangeText={setText}
            error={preview === null ? error : null}
            accessibilityLabel={t('capabilities.mcpAdd.paste.label')}
            placeholder={t('capabilities.mcpAdd.paste.placeholder')}
            multiline
            minLines={9}
            monospace
          />
          {/* A refused read of this paste is settled, never retried on its own: one explicit Try again re-reads the
              same text. A pending approval is not a refusal, so it keeps its own notice and offers no retry. */}
          {preview === null && previewText === text && error !== null && !busy && !approval.approvalId && text.trim() ? (
            <View style={styles.retry}>
              <RoundButton
                testID={`${props.testID}.retry`}
                size="small"
                display="secondary"
                title={t('capabilities.mcpAdd.detail.retry')}
                onPress={props.draft.retryPreview}
              />
            </View>
          ) : null}
        </View>
  );
  const inputSections = (
      <View style={styles.body}>
        {approval.approvalId && props.scope ? (
          <ItemGroup>
            <ActionApprovalPendingNotice
              testID={`${props.testID}.approval`}
              message={t('secrets.catalog.approvalPending')}
              onOpenApproval={() =>
                router.pushRetainingCurrent(
                  `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.scope!.serverId)}`,
                )
              }
            />
          </ItemGroup>
        ) : null}

        {unreadable !== null ? (
          <Text
            variant="meta"
            style={{ color: theme.colors.status.error }}
            testID={`${props.testID}.unreadable`}
          >
            {unreadable === 'no-mcp-servers'
              ? t('capabilities.mcpAdd.paste.noServers')
              : t('capabilities.mcpAdd.paste.unreadable')}
          </Text>
        ) : null}

        {model && model.duplicates.length > 0 ? (
            <View style={styles.servers}>
              {model.duplicates.map((duplicate) => (
                <View
                  key={`duplicate:${duplicate.name}`}
                  style={styles.skipped}
                >
                  <Icon
                    name="info"
                    size={ICON_SIZE.sm}
                    color={theme.colors.text.secondary}
                  />
                  <Text
                    variant="meta"
                    style={{
                      color: theme.colors.text.secondary,
                      flexShrink: 1,
                    }}
                  >
                    {duplicate.inCatalog
                      ? t('capabilities.mcpAdd.paste.skipped', {
                          name: duplicate.name,
                        })
                      : t('capabilities.mcpAdd.paste.skippedPaste', {
                          name: duplicate.name,
                        })}
                  </Text>
                </View>
              ))}
            </View>
        ) : null}

        {model && model.fields.length > 0 ? (
          <ItemGroup
            title={t('capabilities.mcpAdd.paste.otherValues')}
            surface="none"
          >
            <View style={styles.servers}>
              {model.fields.map((ask) => (
                <View key={ask.inputId} style={styles.field}>
                  <Text variant="label" style={{ color: theme.colors.text.primary }}>{ask.key}</Text>
                  {ask.description ? (
                    <Text
                      variant="meta"
                      style={{ color: theme.colors.text.secondary }}
                    >
                      {ask.description}
                    </Text>
                  ) : null}
                  <FieldTextInput
                    testID={`${props.testID}.field.${ask.inputId}`}
                    value={answers.fields[ask.inputId] ?? ''}
                    onChangeText={(next) => setField(ask.inputId, next)}
                    accessibilityLabel={ask.key}
                    secureTextEntry={ask.secret}
                    invalid={
                      (answers.fields[ask.inputId] ?? '').trim().length === 0
                    }
                    monospace
                  />
                </View>
              ))}
            </View>
          </ItemGroup>
        ) : null}

        {model && model.warnings.length > 0 ? (
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {`${t('capabilities.mcpAdd.paste.warnings')} · ${model.warnings.join(' · ')}`}
          </Text>
        ) : null}

        {servers.length > 0 ? (
          <WhereItsOnControl
            testID={`${props.testID}.where`}
            kind="mcp_server"
            presentation="pick"
            rules={rules}
            status="ready"
            projection={projection}
            places={{
              agentIds: props.places.agentIds,
              machines: props.places.placeMachines,
              projects: props.places.projects,
            }}
            agentTakes={props.places.agentTakes}
            onChange={async change => {
              store.update(state => ({ ...state, rules: whereItsOnReach.apply(state.rules, change), where: change }));
              return { ok: true };
            }}
          />
        ) : null}
      </View>
  );
  // The tools band already stands on the body's edge; the field and its sections take it as is.
  const field = <View style={styles.body}>{pasteField}{inputSections}</View>;
  const footer = (
      <CapabilityAddFooter
        start={
          error !== null ? (
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.error`}
            >
              {error}
            </Text>
          ) : open > 0 ? (
            <Text variant="meta" style={{ color: theme.colors.text.secondary }} testID={`${props.testID}.missing`}>
              {t('capabilities.mcpAdd.paste.stillNeeded', { count: open })}
            </Text>
          ) : (
            <View style={styles.note}>
              <Icon
                name="lock"
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
              <Text
                variant="meta"
                style={{ color: theme.colors.text.secondary, flexShrink: 1 }}
              >
                {t('capabilities.mcpAdd.paste.footNote')}
              </Text>
            </View>
          )
        }
      >
        {added || (model && servers.length === 0 && model.duplicates.length > 0) ? (
          <RoundButton title={t('capabilities.add.done')} size="normal" action={async () => { await props.onDone(); }} testID={`${props.testID}.done`} />
        ) : <RoundButton
          title={t('capabilities.mcpAdd.paste.addN', {
            count: servers.length,
          })}
          size="normal"
          loading={busy}
          disabled={
            servers.length === 0 ||
            disabledReason !== null ||
            Boolean(approval.approvalId)
          }
          {...(disabledReason ? { accessibilityHint: disabledReason } : {})}
          action={() => props.draft.create().then(serverIds => { if (serverIds) return props.onAdded(serverIds); })}
          testID={`${props.testID}.add`}
        />}
      </CapabilityAddFooter>
  );
  return props.ctx.renderFound<McpPasteServerModel>({
    field,
    items: servers,
    itemKey: server => server.name,
    anatomy,
    ...(servers.length > 0 ? { groups: [{ key: 'found', title: t('capabilities.mcpAdd.paste.found', {
      count: servers.length,
    }), itemKeys: servers.map(server => server.name) }] } : {}),
    empty: null,
    // Nothing to add until the paste is read: no disabled "Add 0 servers" primary.
    ...(servers.length > 0 || added || (model !== null && model.duplicates.length > 0) ? { footer } : {}),
    renderDetail: (server, ctx) => {
      const remote = server.transport !== 'stdio';
      const asks = server.env.length + server.headers.length + server.literalSecrets.length;
      const signIn = server.auth?.kind === 'oauth';
      const where = remote ? t('capabilities.mcpAdd.paste.remote') : t('capabilities.mcpAdd.paste.local');
      const part = (which: 'values' | 'transport') => (
        <McpPasteServer server={server} answers={answers} secrets={secrets} scope={props.scope}
          hideHead canFlip={jsonPasted} onRow={setRow} onFlip={flipTransport} part={which}
          testID={`${props.testID}.server.${server.name}${which === 'transport' ? '.transport' : ''}`} />
      );
      // The catalog's details, read from the paste (lab `n:paste`): what it needs, what runs where, what happens next.
      return (
        <View>
          <CapabilityDetailHeader title={server.title}
            mark={<HappierBrandMark brand={{ displayName: server.title }} pixelSize={28} externallyLabelled />}
            facts={{ extra: [t('capabilities.mcpAdd.paste.provenance'), where] }}
            testID={`${props.testID}.detail.${server.name}`} />
          <ItemGroup title={t('capabilities.mcpAdd.detail.needsTitle')}
            {...(asks > 0 ? { description: t('capabilities.mcpAdd.detail.needsBody') } : {})}>
            {asks > 0 ? <SectionContentRow>{part('values')}</SectionContentRow> : null}
            {signIn ? <McpAddSignInItem name={server.title} /> : null}
            {asks === 0 && !signIn ? (
              <SectionContentRow>
                <Text variant="body" style={{ color: theme.colors.text.secondary }}>
                  {t('capabilities.mcpAdd.detail.nothingNeeded')}
                </Text>
              </SectionContentRow>
            ) : null}
          </ItemGroup>
          <ItemGroup title={t('capabilities.mcpAdd.detail.runsTitle')}>
            <Item
              icon={<Icon name={remote ? 'globe' : 'terminal'} size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
              title={remote ? t('capabilities.mcpAdd.detail.runsRemote') : t('capabilities.mcpAdd.paste.runsLocal')}
              subtitle={t('capabilities.mcpAdd.detail.runsNote')}
            />
            {remote ? <SectionContentRow>{part('transport')}</SectionContentRow> : null}
          </ItemGroup>
          <McpAddNextSteps savedKey={server.literalSecrets.length > 0 || [...server.env, ...server.headers].some(ask => ask.secret)}
            signIn={signIn} />
          {ctx.pushed ? inputSections : null}
        </View>
      );
    },
  });
}

const NO_SERVERS: readonly McpPasteServerModel[] = [];

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingBottom: theme.space.s24,
    gap: theme.space.s24,
  },
  paste: { gap: theme.space.s8 },
  retry: { flexDirection: 'row' },
  servers: { gap: theme.space.s16 },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  skipped: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  field: { gap: theme.space.s4 },
}));
