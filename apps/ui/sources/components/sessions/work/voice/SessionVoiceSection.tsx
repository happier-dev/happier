import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  readSessionVoicePreferenceV1,
  readSessionVoiceSettingFieldV1,
  readSessionVoiceSettingValueV1,
  type SessionVoicePreferenceV1,
} from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import type { VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol/voice/realtime/providerSettings';
import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { WorkSection, WorkSectionEmptyLine } from '@/components/sessions/work/WorkSection';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Icon } from '@/components/ui/icons/Icon';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t, tLoose } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveSelectedVoiceProviderTitleKey } from '@/voice/registry/providerSelection';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import {
  useVoiceSessionSnapshot,
  voiceSessionManager,
} from '@/voice/session/voiceSession';
import {
  useRealtimeCatalogMenuItems,
  useRealtimeCatalogPreview,
  useRealtimeVoiceCatalog,
} from '@/voice/settings/panels/realtime/realtimeVoiceCatalogMenu';
import { useBundledConversationProviderSettings } from '@/voice/settings/panels/realtime/useBundledConversationProviderSettings';
import type { VoiceCatalogPreviewSynthesizer } from '@/voice/settings/panels/realtime/catalogPreview';
import { resolveSessionVoicePreference } from '@/voice/settings/resolveSessionVoicePreference';

import { readSessionVoiceInUse, resolveSessionVoiceLine } from './sessionVoiceLine';

const providerRegistry = createDefaultVoiceProviderRegistry();

const FOLLOW_ACCOUNT_ID = '__follow__';
const CUSTOM_ID = '__custom__';

function readVoiceId(
  value: VoiceProviderSettingsJsonValueV1 | undefined,
): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Readonly<Record<string, unknown>>).id;
    return typeof id === 'string' && id.trim() ? id : null;
  }
  return null;
}

/**
 * Work › Voice (plan 62 §8, lab `b-work A/V/S`): this Session's voice choice for the account's current
 * conversation provider — the existing searchable provider catalog (with its preview), "Follow
 * account settings" to clear the choice, and a custom name where the provider declares one. The line
 * above the field states the voice the running attempt actually applied (`inUseVoice`), separately
 * from a saved choice that waits for the next attempt; it never relabels current audio. Writes go
 * through `session.voice.preference.set`; a provider without a voice choice says so in one line.
 */
export const SessionVoiceSection = React.memo(function SessionVoiceSection(
  props: Readonly<{
    session: Session;
    serverId: string;
  }>,
) {
  const voiceEnabled = useFeatureEnabled('voice');
  const voiceSetting = useSetting('voice');
  const voice = React.useMemo(
    () => voiceSettingsParse(voiceSetting),
    [voiceSetting],
  );
  const settings = useBundledConversationProviderSettings(voice);
  useVoiceProviderRegistryRevision(providerRegistry);
  if (voiceEnabled !== true || !settings.providerId) return null;
  const choice = settings.sessionChoice;
  if (!choice) return null;
  const declaration = choice.declaration;
  const field = declaration ? readSessionVoiceSettingFieldV1(declaration) : null;
  const providerLabel =
    tLoose(
      resolveSelectedVoiceProviderTitleKey(voice, providerRegistry) ?? '',
    ) || choice.providerId;
  return (
    <WorkSection
      testID="session-work-voice"
      anatomy="page"
      title={t('sessionVoice.title')}
      count=""
      nativeID="voice"
    >
      {field && declaration ? (
        <SessionVoicePicker
          session={props.session}
          serverId={props.serverId}
          providerId={choice.providerId}
          providerLabel={providerLabel}
          declaration={declaration}
          client={choice.client}
          catalogTargetKey={choice.targetKey}
          preview={choice.preview}
          config={choice.config}
          searchPlaceholderKey={
            settings.descriptor?.fields.find(
              (candidate) => candidate.path === field.path,
            )?.searchPlaceholderKey
          }
        />
      ) : (
        <WorkSectionEmptyLine
          testID="session-work-voice.noChoice"
          text={t('sessionVoice.emptyCatalog')}
        />
      )}
    </WorkSection>
  );
});

const SessionVoicePicker = React.memo(function SessionVoicePicker(
  props: Readonly<{
    session: Session;
    serverId: string;
    providerId: string;
    providerLabel: string;
    declaration: Parameters<typeof readSessionVoiceSettingFieldV1>[0];
    client: Parameters<typeof useRealtimeVoiceCatalog>[0]['client'];
    catalogTargetKey: string;
    preview?: VoiceCatalogPreviewSynthesizer;
    config: VoiceProviderSettingsJsonValueV1;
    searchPlaceholderKey?: unknown;
  }>,
) {
  const { theme } = useUnistyles();
  const deviceType = useDeviceType();
  const { session, serverId, providerId, providerLabel, declaration, config } =
    props;
  const field = readSessionVoiceSettingFieldV1(declaration)!;
  const ownerMetadata = readSessionOwnerMetadataView(session);
  const work: unknown =
    ownerMetadata && typeof ownerMetadata === 'object'
      ? Reflect.get(ownerMetadata, 'work')
      : undefined;
  const preference = readSessionVoicePreferenceV1(
    work && typeof work === 'object'
      ? Reflect.get(work, 'voicePreference')
      : null,
  );
  const [open, setOpen] = React.useState(false);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [refused, setRefused] = React.useState(false);
  const { catalog, requestCatalog } = useRealtimeVoiceCatalog({
    client: props.client,
    credentialUsable: true,
    targetKey: props.catalogTargetKey,
  });
  const { previewingId, playPreview, stopPreview } =
    useRealtimeCatalogPreview(providerId, { targetKey: props.catalogTargetKey, synthesize: props.preview });
  const catalogRows = catalog.phase === 'ready' ? catalog.rows : null;
  const resolution = React.useMemo(
    () =>
      resolveSessionVoicePreference({
        providerContributionId: providerId,
        declaration,
        providerConfig: config,
        preference,
        catalog: catalogRows,
      }),
    [catalogRows, config, declaration, preference, providerId],
  );

  // What the running attempt applied — only when that attempt talks to this Session.
  const snapshot = useVoiceSessionSnapshot();
  const attemptTarget =
    snapshot.status === 'connected'
      ? voiceSessionManager.getAttemptTargetSessionAddress()
      : null;
  const sessionAddress = { serverId, sessionId: session.id };
  const inUse = readSessionVoiceInUse(snapshot.inUseVoice, sessionAddress, attemptTarget);

  const nameOf = React.useCallback(
    (id: string | null) => {
      if (!id) return null;
      return catalogRows?.find((row) => row.id === id)?.name ?? id;
    },
    [catalogRows],
  );
  const accountVoiceId = readVoiceId(
    readSessionVoiceSettingValueV1(config, field),
  );
  const chosenId =
    preference && preference.providerContributionId === providerId
      ? readVoiceId(preference.value)
      : null;
  const desiredId = chosenId ?? accountVoiceId;
  const inUseId = inUse ? readVoiceId(inUse.value) : null;
  const line = resolveSessionVoiceLine({
    providerId,
    inUseProviderId: inUse?.providerContributionId ?? null,
    catalogLoaded: catalog.phase === 'ready',
    sessionAddress,
    attemptTargetSessionAddress: attemptTarget,
    saving,
    refused,
    unavailable: resolution.kind === 'unavailable' ? resolution.reason : null,
    providerLabel,
    inUseName: inUse?.displayName ?? null,
    inUseId,
    desiredId,
    desiredName: nameOf(desiredId),
  });

  const write = React.useCallback(
    (next: SessionVoicePreferenceV1 | null) => {
      setSaving(true);
      setRefused(false);
      fireAndForget(
        (async () => {
          try {
            const { createDefaultActionExecutor } =
              await import('@/sync/ops/actions/defaultActionExecutor');
            const result = await createDefaultActionExecutor().execute(
              'session.voice.preference.set',
              {
                sessionId: session.id,
                serverId,
                expectedMetadataRevision: session.metadataVersion,
                preference: next,
              },
              { serverId, surface: 'ui', authority: 'present_user' },
            );
            if (!result.ok) setRefused(true);
            else if (
              ActionApprovalRequestCreatedResultSchema.safeParse(result.result)
                .success
            )
              return;
          } catch {
            setRefused(true);
          } finally {
            setSaving(false);
          }
        })(),
        { tag: 'SessionVoice.setPreference' },
      );
    },
    [serverId, session.id, session.metadataVersion],
  );
  const select = React.useCallback(
    (value: VoiceProviderSettingsJsonValueV1) => {
      write({
        providerContributionId: providerId,
        settingFieldPath: field.path,
        value,
      });
    },
    [field.path, providerId, write],
  );

  const { statusRows, catalogRows: voiceRows } = useRealtimeCatalogMenuItems({
    catalog,
    credentialUsable: true,
    credentialUnavailableDetail: t('sessionVoice.loading'),
    previewingId,
    onPreview: playPreview,
    canPreview: Boolean(props.preview),
    inUseId: inUse?.providerContributionId === providerId ? inUseId : null,
    category: t('sessionVoice.voicesHeading', { provider: providerLabel }),
  });
  const accountVoiceName = nameOf(accountVoiceId);
  const items = React.useMemo(
    (): DropdownMenuItem[] => [
      {
        id: FOLLOW_ACCOUNT_ID,
        title: t('sessionVoice.followAccount'),
        subtitle: accountVoiceName
          ? t('sessionVoice.accountVoice', {
              voice: accountVoiceName,
              provider: providerLabel,
            })
          : undefined,
        icon: (
          <Icon
            name="user-circle"
            size={18}
            color={theme.colors.text.secondary}
          />
        ),
      },
      ...statusRows,
      ...voiceRows,
      ...(field.customIdAllowed
        ? [
            {
              id: CUSTOM_ID,
              title: tLoose('settingsVoice.realtimeProviders.options.custom'),
            },
          ]
        : []),
    ],
    [
      accountVoiceName,
      field.customIdAllowed,
      providerLabel,
      statusRows,
      theme.colors.text.secondary,
      voiceRows,
    ],
  );
  const selectedId = chosenId ?? FOLLOW_ACCOUNT_ID;
  const selectedName = chosenId ? nameOf(chosenId) : accountVoiceName;
  const searchPlaceholder =
    typeof props.searchPlaceholderKey === 'string'
      ? tLoose(props.searchPlaceholderKey)
      : undefined;

  return (
    <>
      <DropdownMenu
        testID="session-work-voice.picker"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) requestCatalog();
          else stopPreview();
        }}
        variant="selectable"
        search
        searchPlaceholder={searchPlaceholder}
        selectedId={selectedId}
        showCategoryTitles
        matchTriggerWidth
        connectToTrigger
        rowKind="item"
        itemRowProps={{ rightElementOutsidePressable: true }}
        footer={
          <Text style={styles.footer}>{t('sessionVoice.preferenceHint')}</Text>
        }
        itemTrigger={{
          title: line,
          showSelectedSubtitle: false,
          // One value, as it is said: "Sage · OpenAI".
          detailFormatter: () =>
            selectedName
              ? joinHappierFacts(selectedName, providerLabel)
              : t('sessionVoice.chooseVoice'),
          field: {
            leading: (
              <Icon
                name="microphone"
                size={16}
                color={theme.colors.text.secondary}
              />
            ),
            invalid: resolution.kind === 'unavailable',
          },
          itemProps: {
            accessibilityLabel: t('sessionVoice.pickerA11y', {
              name: getSessionName(session, serverId),
            }),
            accessoryLayout: deviceType === 'phone' ? 'stacked' : 'adaptive',
          },
        }}
        items={items}
        onSelect={(id) => {
          if (id === '__retry__') {
            requestCatalog();
            return;
          }
          if (id === '__status__') return;
          setOpen(false);
          if (id === FOLLOW_ACCOUNT_ID) {
            if (preference) write(null);
            return;
          }
          if (id === CUSTOM_ID) {
            setCustomOpen(true);
            return;
          }
          select(field.valueShape === 'string' ? id : { kind: 'catalog', id });
        }}
      />
      {customOpen ? (
        <FieldValueItem
          testID="session-work-voice.custom"
          fieldTestID="session-work-voice.custom.field"
          title={tLoose('settingsVoice.realtimeProviders.options.custom')}
          autoFocus
          value={chosenId ?? ''}
          onCommit={(draft) => {
            setCustomOpen(false);
            const id = draft.trim();
            if (!id) return chosenId ?? '';
            select(field.valueShape === 'string' ? id : { kind: 'custom', id });
            return id;
          }}
        />
      ) : null}
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The picker's quiet footer: when the choice applies, said once.
  footer: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
  },
}));
