import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  BrowserLoginSourcesResultV1Schema,
  BrowserProfileLoginsImportResultV1Schema,
  type BrowserLoginImportFailureCodeV1,
  type BrowserLoginImportRecordV1,
  type BrowserProfileLoginsImportResultV1,
  type BrowserProfileLoginsImportV1,
} from '@happier-dev/protocol/browser/profile/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { z } from 'zod/mini';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { StringListField } from '@/components/ui/forms/StringListField';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import {
  useMachineDisplayNamesById,
  useMachineListForServer,
} from '@/sync/store/hooks';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
  formatMachineDisplayNameParts,
  resolveMachineDisplayNameParts,
} from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

/** The managed profile that receives the sign-ins: the page in view, on the Machine that runs it. */
export type BrowserLoginImportDestination = Readonly<{
  serverId: string;
  accountId: string;
  machineId: string;
  browserSessionId: string;
  viewId: string;
  profileId: string;
  profileName: string | null;
}>;

type Kind = BrowserProfileLoginsImportV1['kind'];
type Sources = z.infer<typeof BrowserLoginSourcesResultV1Schema>;
type SourceRead = Readonly<
  | { machineId: string; state: 'loading' }
  | { machineId: string; state: 'failed' }
  | { machineId: string; state: 'ready'; sources: Sources }
>;
type Phase = Readonly<
  | { kind: 'editing' }
  | { kind: 'importing' }
  | { kind: 'settled'; result: BrowserProfileLoginsImportResultV1 }
>;

const execute = createFrontDoorActionExecute();

/** Opens the import sheet over the browser: anchored on wide layouts, a bottom sheet on phones. */
export function presentBrowserLoginImportSheet(
  destination: BrowserLoginImportDestination,
): void {
  Modal.show({
    component: BrowserLoginImportSheet,
    props: { destination },
    chrome: {
      ...createAnchoredSheetChrome({
        title: t('browserShell.loginImport.title'),
        testID: 'browser-login-import',
      }),
      bodyScroll: 'auto',
    },
    closeOnBackdrop: false,
  });
}

/** A typed address or bare host ("github.com") as the site URL the source read expects; null when it is not one. */
function siteUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    return url.hostname.includes('.') || url.hostname === 'localhost'
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function codeLabel(
  code: BrowserLoginImportFailureCodeV1,
  sourceBrowser?: string | null,
): string {
  // A locked source is usually the browser still open on that Machine: name it when it is known.
  if (code === 'source_locked' && sourceBrowser)
    return t('browserShell.loginImport.sourceLockedNamed', {
      browser: sourceBrowser,
    });
  return t(`browserShell.loginImport.codes.${code}`);
}

/**
 * The row title for a source profile. Chrome-family labels already name their browser
 * ("Chrome · Work"); a Firefox label is the bare profile name, so it gains the same lead.
 */
function sourceTitle(source: Readonly<{ browser: Sources['sources'][number]['browser']; label: string }>): string {
  if (source.browser !== 'firefox') return source.label;
  const browser = t('browserShell.loginImport.browsers.firefox');
  return source.label === browser || source.label.startsWith(`${browser} ·`)
    ? source.label
    : `${browser} · ${source.label}`;
}

/** The browser a source runs in, for "Close Chrome": the label's lead before " · ". */
function sourceBrowserName(source: Readonly<{ browser: Sources['sources'][number]['browser']; label: string }> | undefined): string | null {
  if (!source) return null;
  if (source.browser === 'firefox') return t('browserShell.loginImport.browsers.firefox');
  return source.label.split(' · ')[0]?.trim() || null;
}

/** The causes whose next step the result section says once, above the rows each one explains. */
const NEXT_STEP_CODES = ['app_bound_encryption', 'partition_unsupported'] as const;

function recordDetail(record: BrowserLoginImportRecordV1): string {
  if (record.reason === 'this passkey tracks a usage counter')
    return t('browserShell.loginImport.counterReason');
  if (record.status === 'imported')
    return t('browserShell.loginImport.status.imported');
  return record.code
    ? codeLabel(record.code)
    : t(`browserShell.loginImport.status.${record.status}`);
}

/**
 * Bring cookies or passkeys into the managed browser profile in view. The source list is read from the
 * chosen Machine only while this sheet is open; Import is the person's one confirmation of the exact
 * selection, and the shared `browser.profile.logins.import` Action does the rest. Nothing here reads a
 * cookie or a key.
 */
export function BrowserLoginImportSheet(
  props: CustomModalInjectedProps &
    Readonly<{ destination: BrowserLoginImportDestination }>,
) {
  const { destination } = props;
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const [kind, setKind] = React.useState<Kind>('cookies');
  const [sourceMachineId, setSourceMachineId] = React.useState(
    destination.machineId,
  );
  const [sourceKey, setSourceKey] = React.useState<string | null>(null);
  const [sites, setSites] = React.useState<string[]>(['']);
  const [passkeyRefs, setPasskeyRefs] = React.useState<readonly string[]>([]);
  const [phase, setPhase] = React.useState<Phase>({ kind: 'editing' });
  const [read, setRead] = React.useState<SourceRead>({
    machineId: destination.machineId,
    state: 'loading',
  });
  const [readAttempt, setReadAttempt] = React.useState(0);
  const importController = React.useRef<AbortController | null>(null);

  const machines = useMachineListForServer(destination.serverId) ?? [];
  const machineIds = React.useMemo(
    () => [
      ...new Set([
        destination.machineId,
        ...machines.filter((m) => isMachineOnline(m)).map((m) => m.id),
      ]),
    ],
    [destination.machineId, machines],
  );
  const machineNames = useMachineDisplayNamesById(machineIds);
  // Machines shown together are named together: a same-named sibling gets the suffix that tells it apart.
  const machineParts = React.useMemo(
    () =>
      resolveMachineDisplayNameParts(
        machines.filter((m) => machineIds.includes(m.id)),
      ),
    [machineIds, machines],
  );
  const machineName = (id: string) => {
    const parts = machineParts.get(id);
    return parts
      ? formatMachineDisplayNameParts(parts)
      : (machineNames[id] ?? t('browserShell.loginImport.unnamedMachine'));
  };

  // The source inventory is private to its Machine and read only while the Cookies arm is open.
  React.useEffect(() => {
    if (kind !== 'cookies') return;
    const controller = new AbortController();
    setRead({ machineId: sourceMachineId, state: 'loading' });
    void machineRpcWithServerScope<unknown, Record<string, never>>({
      serverId: destination.serverId,
      accountId: destination.accountId,
      machineId: sourceMachineId,
      method: RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES,
      payload: {},
      signal: controller.signal,
    }).then(
      (raw) => {
        if (controller.signal.aborted) return;
        const parsed = BrowserLoginSourcesResultV1Schema.safeParse(raw);
        setRead(
          parsed.success
            ? {
                machineId: sourceMachineId,
                state: 'ready',
                sources: parsed.data,
              }
            : { machineId: sourceMachineId, state: 'failed' },
        );
      },
      () => {
        if (!controller.signal.aborted)
          setRead({ machineId: sourceMachineId, state: 'failed' });
      },
    );
    return () => controller.abort();
  }, [
    destination.accountId,
    destination.serverId,
    kind,
    readAttempt,
    sourceMachineId,
  ]);
  React.useEffect(() => () => importController.current?.abort(), []);

  const sources = read.state === 'ready' ? read.sources : null;
  const chosenSource =
    sources?.sources.find(
      (source) => `${source.browser}:${source.profileId}` === sourceKey,
    ) ?? (sources?.sources.length === 1 ? sources.sources[0] : undefined);
  const siteUrls = sites.map(siteUrl);
  const typedSites = sites.filter((site) => site.trim().length > 0);
  const catalog = useSavedSecretCatalog({
    scope: { serverId: destination.serverId, accountId: destination.accountId },
    includeMaterial: false,
  });
  const passkeys = catalog.entries.filter(
    (entry) =>
      entry.relationship === 'owner' && entry.storage?.kind === 'passkey',
  );

  const input: BrowserProfileLoginsImportV1 | null =
    kind === 'cookies'
      ? chosenSource &&
        typedSites.length > 0 &&
        siteUrls.every((url, index) => url || !sites[index]?.trim())
        ? {
            kind: 'cookies',
            machineId: destination.machineId,
            browserSessionId: destination.browserSessionId,
            viewId: destination.viewId,
            profileId: destination.profileId,
            sourceMachineId,
            source: {
              browser: chosenSource.browser,
              profileId: chosenSource.profileId,
            },
            sites: siteUrls.filter((url): url is string => url !== null),
          }
        : null
      : passkeyRefs.length > 0
        ? {
            kind: 'passkeys',
            machineId: destination.machineId,
            browserSessionId: destination.browserSessionId,
            viewId: destination.viewId,
            profileId: destination.profileId,
            refs: [...passkeyRefs],
          }
        : null;

  const runImport = async () => {
    if (!input || phase.kind === 'importing') return;
    const controller = new AbortController();
    importController.current = controller;
    setPhase({ kind: 'importing' });
    const response = await execute.confirmed(
      'browser.profile.logins.import',
      input,
      {
        surface: 'ui',
        serverId: destination.serverId,
        expectedAccountId: destination.accountId,
        signal: controller.signal,
      },
    );
    if (importController.current !== controller) return;
    importController.current = null;
    const parsed = response.ok
      ? BrowserProfileLoginsImportResultV1Schema.safeParse(response.result)
      : null;
    setPhase({
      kind: 'settled',
      result: controller.signal.aborted
        ? { status: 'unavailable', code: 'canceled' }
        : parsed?.success
          ? parsed.data
          : { status: 'unavailable', code: 'import_unknown' },
    });
  };
  const cancel = () => {
    if (phase.kind === 'importing') {
      importController.current?.abort();
      return;
    }
    props.onClose();
  };

  const busy = phase.kind === 'importing';
  const intoValue = t('browserShell.loginImport.intoValue', {
    profile:
      destination.profileName ?? t('browserShell.loginImport.thisBrowser'),
    machine: machineName(destination.machineId),
  });

  const settled = phase.kind === 'settled' ? phase.result : null;
  // The card's footer holds the decision, so it stays in view while the body scrolls (sibling:
  // DeploymentLinkMachineSheet). Without card chrome (an embedding host) it ends the body.
  const footer = (
    <RoundButtonSizeScope size="normal" presentation="uniform">
      <View style={styles.actions}>
        {settled ? (
          <>
            {settled.status === 'unavailable' && settled.code !== 'canceled' ? (
              <RoundButton
                testID="browser-login-import:back"
                display="secondary"
                title={t('common.retry')}
                onPress={() => setPhase({ kind: 'editing' })}
              />
            ) : null}
            <RoundButton
              testID="browser-login-import:done"
              title={t('browserShell.loginImport.done')}
              onPress={props.onClose}
            />
          </>
        ) : (
          <>
            <RoundButton
              testID="browser-login-import:cancel"
              display="secondary"
              title={t('common.cancel')}
              onPress={cancel}
            />
            <RoundButton
              testID="browser-login-import:import"
              title={
                busy
                  ? t('browserShell.loginImport.importing')
                  : t('browserShell.loginImport.import')
              }
              loading={busy}
              disabled={!input || busy}
              onPress={() => {
                void runImport();
              }}
            />
          </>
        )}
      </View>
    </RoundButtonSizeScope>
  );
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      subtitle: settled ? undefined : t('browserShell.loginImport.purpose'),
      footer,
    });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  const inlineFooter = setChrome ? null : (
    <View style={styles.inlineFooter}>{footer}</View>
  );

  if (settled) {
    return (
      <ListPresentationProvider value="page" pageInsets="contained">
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.frame}
          testID="browser-login-import:result"
        >
          <ResultBody
            result={settled}
            into={intoValue}
            sourceBrowser={kind === 'cookies' ? sourceBrowserName(chosenSource) : null}
          />
          {inlineFooter}
        </ScrollView>
      </ListPresentationProvider>
    );
  }

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.frame}
      keyboardShouldPersistTaps="handled"
      testID="browser-login-import:form"
    >
      {setChrome ? null : (
        <Text variant="body" style={styles.purpose}>
          {t('browserShell.loginImport.purpose')}
        </Text>
      )}
      <ItemGroup header="none">
        <SegmentedChoiceItem
          title={t('browserShell.loginImport.kindTitle')}
          testIDPrefix="browser-login-import:kind"
          options={[
            { id: 'cookies', label: t('browserShell.loginImport.kindCookies') },
            {
              id: 'passkeys',
              label: t('browserShell.loginImport.kindPasskeys'),
            },
          ]}
          value={kind}
          disabled={busy}
          onChange={setKind}
          showDivider={false}
        />
      </ItemGroup>

      {kind === 'cookies' ? (
        <>
          <ItemGroup
            title={t('browserShell.loginImport.fromTitle')}
            description={t('browserShell.loginImport.fromDescription')}
            // The source Machine is a choice among many, so one chooser in the section header
            // (the Machine chip used across the app) rather than a row per Machine.
            action={
              machineIds.length > 1 ? (
                <SelectionListFilterChip
                  filter={{
                    id: 'source-machine',
                    label: t('browserShell.loginImport.fromTitle'),
                    testID: 'browser-login-import:source-machine',
                    valueLabel:
                      machineParts.get(sourceMachineId)?.name ??
                      machineName(sourceMachineId),
                    ...(machineParts.get(sourceMachineId)?.hint
                      ? { valueQualifier: machineParts.get(sourceMachineId)!.hint! }
                      : {}),
                    icon: (
                      <Icon
                        name="laptop"
                        size={ICON_SIZE.sm}
                        color={theme.colors.text.secondary}
                      />
                    ),
                    presence: 'online',
                    disabled: busy,
                    options: machineIds.map((id) => ({
                      id,
                      label: machineName(id),
                    })),
                    selectedId: sourceMachineId,
                    onChange: (id) => {
                      setSourceMachineId(id);
                      setSourceKey(null);
                    },
                  }}
                />
              ) : undefined
            }
          >
            {read.state === 'loading' ? (
              <SectionContentRow>
                <SurfaceStateCard
                  testID="browser-login-import:sources-loading"
                  kind="loading"
                  size="line"
                  title={t('browserShell.loginImport.sourcesLoading')}
                  accessibilitySemantics="status"
                />
              </SectionContentRow>
            ) : read.state === 'failed' ? (
              <SectionContentRow>
                <SurfaceStateCard
                  testID="browser-login-import:sources-failed"
                  kind="error"
                  size="line"
                  title={t('browserShell.loginImport.sourcesFailed')}
                  action={{
                    label: t('common.retry'),
                    testID: 'browser-login-import:sources-retry',
                    onPress: () => setReadAttempt((n) => n + 1),
                  }}
                />
              </SectionContentRow>
            ) : (
              <>
                {read.sources.sources.map((source) => {
                  const key = `${source.browser}:${source.profileId}`;
                  return (
                    <Item
                      key={key}
                      testID={`browser-login-import:source:${key}`}
                      title={sourceTitle(source)}
                      selected={chosenSource === source}
                      showChevron={false}
                      disabled={busy}
                      onPress={() => setSourceKey(key)}
                    />
                  );
                })}
                {read.sources.sources.length === 0 ? (
                  <Item
                    testID="browser-login-import:sources-empty"
                    title={t('browserShell.loginImport.sourcesEmpty')}
                    mode="info"
                    showChevron={false}
                  />
                ) : null}
                {read.sources.unsupported.map((entry) => (
                  <Item
                    key={entry.browser}
                    testID={`browser-login-import:unsupported:${entry.browser}`}
                    title={t(
                      `browserShell.loginImport.browsers.${entry.browser}`,
                    )}
                    subtitle={
                      entry.code === 'source_unavailable'
                        ? t('browserShell.loginImport.notInstalled')
                        : codeLabel(entry.code)
                    }
                    mode="info"
                    showChevron={false}
                    disabled
                  />
                ))}
              </>
            )}
          </ItemGroup>
          <ItemGroup
            title={t('browserShell.loginImport.sitesTitle')}
            description={t('browserShell.loginImport.sitesDescription')}
          >
            <Item
              title={t('browserShell.loginImport.sitesTitle')}
              accessoryLayout="stacked"
              showChevron={false}
              showDivider={false}
              rightElement={
                <StringListField
                  testID="browser-login-import:sites"
                  values={sites}
                  onChange={setSites}
                  itemLabel={(position) =>
                    t('browserShell.loginImport.siteLabel', { position })
                  }
                  removeLabel={(position) =>
                    t('browserShell.loginImport.siteRemove', { position })
                  }
                  addLabel={t('browserShell.loginImport.siteAdd')}
                  itemPlaceholder="github.com"
                  disabled={busy}
                  itemError={(index) =>
                    sites[index]?.trim() && !siteUrls[index]
                      ? t('browserShell.loginImport.siteInvalid')
                      : null
                  }
                />
              }
            />
          </ItemGroup>
        </>
      ) : (
        <ItemGroup
          title={t('browserShell.loginImport.passkeysTitle')}
          description={t('browserShell.loginImport.passkeysDescription')}
        >
          {passkeys.length === 0 ? (
            <Item
              testID="browser-login-import:passkeys-empty"
              title={t('browserShell.loginImport.passkeysEmpty')}
              mode="info"
              showChevron={false}
            />
          ) : (
            passkeys.map((entry) => {
              const chosen = passkeyRefs.includes(entry.ref);
              return (
                <Item
                  key={entry.ref}
                  testID={`browser-login-import:passkey:${entry.ref}`}
                  title={entry.name ?? t('secrets.catalog.unavailableName')}
                  icon={
                    <Icon
                      name="key"
                      size={ICON_SIZE.md}
                      color={theme.colors.text.secondary}
                    />
                  }
                  selected={chosen}
                  showChevron={false}
                  disabled={busy || entry.materialStatus !== 'ready'}
                  onPress={() =>
                    setPasskeyRefs((current) =>
                      chosen
                        ? current.filter((ref) => ref !== entry.ref)
                        : [...current, entry.ref],
                    )
                  }
                />
              );
            })
          )}
        </ItemGroup>
      )}

      <ItemGroup
        title={t('browserShell.loginImport.intoTitle')}
        description={
          kind === 'cookies'
            ? t('browserShell.loginImport.disclosure')
            : t('browserShell.loginImport.disclosurePasskeys')
        }
      >
        <Item
          testID="browser-login-import:into"
          title={intoValue}
          mode="info"
          showChevron={false}
          showDivider={false}
          icon={
            <Icon
              name="globe"
              size={ICON_SIZE.md}
              color={theme.colors.text.secondary}
            />
          }
        />
      </ItemGroup>

      {inlineFooter}
    </ScrollView>
    </ListPresentationProvider>
  );
}

/** What happened, item by item: a completed import can still hold skipped and refused entries. */
function ResultBody(
  props: Readonly<{
    result: BrowserProfileLoginsImportResultV1;
    into: string;
    /** The source's browser ("Chrome"), so a locked source can say which one to close. */
    sourceBrowser: string | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { result } = props;
  if (result.status !== 'completed') {
    const canceled =
      result.status === 'unavailable' && result.code === 'canceled';
    return (
      <ItemGroup
        title={
          canceled
            ? t('browserShell.loginImport.canceledTitle')
            : t('browserShell.loginImport.failedTitle')
        }
      >
        <Item
          testID="browser-login-import:outcome"
          title={
            result.status === 'needs_source'
              ? t('browserShell.loginImport.sourcesEmpty')
              : codeLabel(result.code, props.sourceBrowser)
          }
          icon={
            canceled ? undefined : (
              <Icon
                name="warning"
                size={ICON_SIZE.md}
                color={theme.colors.state.warning.foreground}
              />
            )
          }
          titleLines={0}
          mode="info"
          showChevron={false}
          showDivider={false}
        />
      </ItemGroup>
    );
  }
  const imported = result.records.filter(
    (record) => record.status === 'imported',
  ).length;
  // A skipped cause (Chrome's app-bound cookies, a container) is said briefly on each row; its next step
  // is said once, in the section's description above them.
  const nextSteps = NEXT_STEP_CODES.filter((code) =>
    result.records.some((record) => record.code === code),
  ).map((code) => t(`browserShell.loginImport.nextSteps.${code}`));
  return (
    <ItemGroup
      title={
        result.records.length === 0
          ? t('browserShell.loginImport.resultNone')
          : t('browserShell.loginImport.resultSummary', {
              imported,
              total: result.records.length,
            })
      }
      description={[props.into, ...nextSteps].join('\n')}
    >
      {result.records.map((record, index) => (
        <Item
          key={`${record.domain}:${record.name}:${index}`}
          testID={`browser-login-import:record:${index}`}
          title={
            record.name ? `${record.domain} · ${record.name}` : record.domain
          }
          subtitle={recordDetail(record)}
          subtitleLines={0}
          icon={
            <Icon
              name={
                record.status === 'imported' ? 'check-circle' : 'warning-circle'
              }
              size={ICON_SIZE.md}
              color={
                record.status === 'failed'
                  ? theme.colors.state.warning.foreground
                  : theme.colors.text.secondary
              }
            />
          }
          mode="info"
          showChevron={false}
          showDivider={index < result.records.length - 1}
        />
      ))}
    </ItemGroup>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  scroll: { flexShrink: 1, minHeight: 0 },
  frame: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s16,
    gap: theme.space.s4,
  },
  purpose: {
    color: theme.colors.text.secondary,
    paddingBottom: theme.space.s8,
  },
  inlineFooter: { paddingTop: theme.space.s12 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
