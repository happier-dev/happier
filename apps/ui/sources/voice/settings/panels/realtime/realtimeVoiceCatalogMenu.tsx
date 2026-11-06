import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getVoiceContributedSettingsDeclarations, voiceSettingsDeclarationRegistry } from '@/voice/settings/voiceContributedSettingsDeclarations';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { localNeuralTtsPreviewController } from '../localTts/providers/localNeural/previewLocalNeuralTts';
import type { VoiceRemoteCatalogState } from '@/voice/settings/remoteCatalogState';

import {
  readRealtimeCatalogPreview,
  stopRealtimeCatalogPreview,
  subscribeRealtimeCatalogPreview,
} from './catalogPreview';
import { readVoiceCatalogSettingsActionResult, type VoiceCatalogRow } from './voiceCatalog';

const PREVIEW_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

export type RealtimeCatalogState = VoiceRemoteCatalogState<VoiceCatalogRow>;

const retainedCatalogRows = new Map<string, readonly VoiceCatalogRow[]>();
const retainedCatalogListeners = new Map<string, Set<() => void>>();

function retainCatalogRows(targetKey: string, rows: readonly VoiceCatalogRow[]) {
  const previous = retainedCatalogRows.get(targetKey);
  const retained = retainKeyedRows(previous, rows, row => row.id);
  if (retained === previous) return retained;
  retainedCatalogRows.set(targetKey, retained);
  retainedCatalogListeners.get(targetKey)?.forEach((listener) => listener());
  return retained;
}

type CatalogOperation = 'preview' | 'stopPreview' | 'listCatalog' | 'retryCatalog';
function readCatalogOperationSetting(providerId: string, operation: CatalogOperation): SettingRef | undefined {
  if (providerId === BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID) {
    const localOperation = { preview: 'ttsPreview', stopPreview: 'ttsPreviewStop', listCatalog: 'ttsCatalog', retryCatalog: 'ttsCatalogRetry' } as const;
    return VOICE_CONVERSATIONS_SETTINGS.settings[localOperation[operation]];
  }
  const page = getVoiceContributedSettingsDeclarations(voiceSettingsDeclarationRegistry)
    .find(page => page.pageId === 'voiceConversations' && page.sections[`provider.${providerId}`]);
  return Object.values(page?.settings ?? {}).find(candidate => candidate.anchor.endsWith(`.${operation}`));
}

/** The one catalog preview player per provider, shared by Settings and a Session's Work voice picker. */
export function useRealtimeCatalogPreview(providerId: string, options?: Readonly<{
  targetKey?: string;
}>): Readonly<{
  previewingId: string | null;
  playPreview: (row: VoiceCatalogRow) => Promise<void>;
  stopPreview: () => Promise<void>;
  retirePreview: () => void;
}> {
  const scope = useAccountSettingsScope();
  const actions = useMountedActionExecution(scope);
  const snapshot = React.useSyncExternalStore(
    subscribeRealtimeCatalogPreview,
    readRealtimeCatalogPreview,
    readRealtimeCatalogPreview,
  );
  const localPreviewId = React.useSyncExternalStore(localNeuralTtsPreviewController.subscribe,
    localNeuralTtsPreviewController.read, localNeuralTtsPreviewController.read);
  const localNeural = providerId === BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID;
  const previewingId = localNeural ? localPreviewId : snapshot?.providerId === providerId ? snapshot.voiceId : null;
  const targetKey = options?.targetKey ?? providerId;
  const previewLifetime = React.useMemo(() => ({ controller: new AbortController() }), [providerId, targetKey]);
  const ownedPreview = React.useRef<ReturnType<typeof readRealtimeCatalogPreview>>(null);
  const retirePreview = React.useCallback(() => {
    previewLifetime.controller.abort();
    previewLifetime.controller = new AbortController();
    // URL playback outlives its completed Action. Only release this picker's sample;
    // pending/native playback is retired by its own Action cancellation signal.
    if (ownedPreview.current && readRealtimeCatalogPreview() === ownedPreview.current) stopRealtimeCatalogPreview(providerId);
    ownedPreview.current = null;
  }, [previewLifetime, providerId]);
  React.useEffect(() => {
    if (previewLifetime.controller.signal.aborted) previewLifetime.controller = new AbortController();
    return retirePreview;
  }, [previewLifetime, retirePreview]);
  const invoke = React.useCallback(async (operation: 'preview' | 'stopPreview', voiceId?: string) => {
    const setting = readCatalogOperationSetting(providerId, operation);
    if (!setting) return;
    const signal = previewLifetime.controller.signal;
    const result = await actions.execute('settings.invoke', { anchor: setting.anchor,
      ...(voiceId ? { input: { kind: 'voice_preview', voiceId } } : {}) }, { signal });
    if (!localNeural && operation === 'preview' && result.ok && !signal.aborted) {
      const receipt = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].safeParse(result.result);
      const playing = readRealtimeCatalogPreview();
      if (receipt.success && receipt.data.status === 'completed' && playing?.providerId === providerId && playing.voiceId === voiceId) {
        ownedPreview.current = playing;
      }
    }
  }, [actions.execute, localNeural, previewLifetime, providerId]);
  const stopPreview = React.useCallback(() => invoke('stopPreview'), [invoke]);
  const playPreview = React.useCallback(
    async (row: VoiceCatalogRow) => {
      if (!row.previewUrl && !row.previewAvailable && !localNeural) return;
      if (previewingId === row.id) {
        await stopPreview();
        return;
      }
      await invoke('preview', row.id);
    },
    [invoke, localNeural, previewingId, stopPreview],
  );
  return { previewingId, playPreview, stopPreview, retirePreview };
}

/**
 * The searchable provider voice catalog as menu rows: its status row (credential, loading, retry,
 * empty), then the voices with their preview control. `inUseId` marks the voice the current attempt
 * actually applied — a fact of the running conversation, never the saved choice.
 */
export function useRealtimeCatalogMenuItems(
  params: Readonly<{
    catalog: RealtimeCatalogState;
    credentialUsable: boolean;
    credentialUnavailableDetail: string;
    previewingId: string | null;
    onPreview: (row: VoiceCatalogRow) => void | Promise<void>;
    canPreview?: boolean;
    inUseId?: string | null;
    category?: string;
    /** Asks the catalog again: the failure row's one recovery. */
    onRetry?: () => void;
  }>,
): Readonly<{
  statusRows: DropdownMenuItem[];
  catalogRows: DropdownMenuItem[];
}> {
  const { theme } = useUnistyles();
  const {
    catalog,
    credentialUsable,
    credentialUnavailableDetail,
    previewingId,
    onPreview,
    canPreview,
    inUseId,
    category,
    onRetry,
  } = params;
  return React.useMemo(() => {
    const catalogRows: DropdownMenuItem[] =
      catalog.phase === 'ready'
        ? catalog.rows.map((row) => {
            const inUse =
              inUseId !== undefined && inUseId !== null && inUseId === row.id;
            const preview = row.previewUrl || row.previewAvailable || canPreview ? (
              <IconButton
                variant="plain"
                minimumInteractiveTargetSize={PREVIEW_TARGET_SIZE}
                accessibilityLabel={t(
                  'settingsVoice.realtimeProviders.catalog.preview',
                  { voice: row.name },
                )}
                onPress={(event) => {
                  event?.stopPropagation?.();
                  const pending = onPreview(row);
                  if (pending) fireAndForget(pending, { tag: 'RealtimeCatalogPreview.play' });
                }}
                icon={<Icon
                  name={previewingId === row.id ? 'stop-circle' : 'play-circle'}
                  size={24}
                  color={theme.colors.text.secondary}
                />}
              />
            ) : null;
            // The preview leads the row (as in the lab's voice list), so names align on one edge and the
            // right edge is left for the one fact that can need it: the voice in use.
            return {
              id: row.id,
              title: row.name,
              subtitle: row.subtitle,
              ...(category ? { category } : {}),
              ...(preview ? { icon: preview } : {}),
              ...(inUse ? {
                rightElement: (
                  <StatusPill
                    variant="neutral"
                    hideDot
                    label={t('sessionVoice.inUse')}
                    labelVariant="phrase"
                  />
                ),
              } : {}),
            };
          })
        : [];
    const statusRows: DropdownMenuItem[] = !credentialUsable
      ? [
          {
            id: '__status__',
            title: credentialUnavailableDetail,
            disabled: true,
          },
        ]
      : catalog.phase === 'loading'
        ? [{ id: '__status__', title: t('common.loading'), disabled: true }]
        : catalog.phase === 'error'
          ? [
              {
                // One sentence and its one recovery, kept at the foot of the account-voice row.
                // One sentence and its one recovery, kept at the foot of the account-voice row.
                id: '__retry__',
                title: tLoose('settingsVoice.realtimeProviders.catalog.loadFailed'),
                rightElement: (
                  <RoundButton
                    testID="voice-catalog.retry"
                    size="small"
                    display="secondary"
                    title={t('common.retry')}
                    onPress={(event) => {
                      event?.stopPropagation?.();
                      onRetry?.();
                    }}
                  />
                ),
              },
            ]
          : catalog.phase === 'ready' && catalog.rows.length === 0
            ? [
                {
                  id: '__status__',
                  title: tLoose(
                    'settingsVoice.realtimeProviders.catalog.empty',
                  ),
                  disabled: true,
                },
              ]
            : [];
    return { statusRows, catalogRows };
  }, [
    catalog,
    canPreview,
    category,
    credentialUnavailableDetail,
    credentialUsable,
    inUseId,
    onPreview,
    onRetry,
    previewingId,
    theme.colors.text.secondary,
  ]);
}

/**
 * The provider's voice catalog, read on demand through its declared Settings Action and retained
 * per `targetKey` (provider + credential): one UI request/retention owner for Settings and Work.
 */
export function useRealtimeVoiceCatalog(params: Readonly<{
  providerId: string | null;
  catalogAvailable: boolean;
  credentialUsable: boolean;
  targetKey: string;
  declaredRows?: readonly VoiceCatalogRow[] | null;
}>): Readonly<{
  catalog: RealtimeCatalogState;
  lastKnownRows: readonly VoiceCatalogRow[] | null;
  requestCatalog: () => void;
  resetCatalog: () => void;
}> {
  const { providerId, catalogAvailable, credentialUsable, targetKey, declaredRows } = params;
  const scope = useAccountSettingsScope();
  const actions = useMountedActionExecution(scope);
  const subscribeRetainedRows = React.useCallback((listener: () => void) => {
    const listeners = retainedCatalogListeners.get(targetKey) ?? new Set<() => void>();
    retainedCatalogListeners.set(targetKey, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) retainedCatalogListeners.delete(targetKey);
    };
  }, [targetKey]);
  const readRetainedRows = React.useCallback(() => retainedCatalogRows.get(targetKey) ?? null, [targetKey]);
  const retainedRows = React.useSyncExternalStore(subscribeRetainedRows, readRetainedRows, readRetainedRows);
  const lastKnownRows = declaredRows ?? retainedRows;
  const [state, setState] = React.useState<Readonly<{ targetKey: string; value: RealtimeCatalogState }> | null>(null);
  const catalog: RealtimeCatalogState = declaredRows ? { phase: 'ready', rows: declaredRows }
    : state?.targetKey === targetKey ? state.value : { phase: 'idle' };
  const requestRef = React.useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const requestCatalog = React.useCallback(() => {
    if (!providerId || (!catalogAvailable && !declaredRows) || !credentialUsable || catalog.phase === 'loading') return;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = requestRef.current.generation + 1;
    requestRef.current = { generation, controller };
    setState({ targetKey, value: { phase: 'loading' } });
    const read = async () => {
      const setting = readCatalogOperationSetting(providerId, catalog.phase === 'error' ? 'retryCatalog' : 'listCatalog');
      if (!setting) throw new Error('voice_catalog_unavailable');
      const result = await actions.execute('settings.invoke', { anchor: setting.anchor }, { signal: controller.signal });
      return readVoiceCatalogSettingsActionResult(result);
    };
    void read().then((rows) => {
      if (requestRef.current.generation === generation && !controller.signal.aborted) {
        const retained = retainCatalogRows(targetKey, rows);
        setState({ targetKey, value: { phase: 'ready', rows: retained } });
      }
    }).catch(() => {
      if (requestRef.current.generation === generation && !controller.signal.aborted) setState({ targetKey, value: { phase: 'error' } });
    });
  }, [actions.execute, catalog.phase, catalogAvailable, credentialUsable, declaredRows, providerId, targetKey]);
  const resetCatalog = React.useCallback(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { generation: requestRef.current.generation + 1, controller: null };
    retainedCatalogRows.delete(targetKey);
    retainedCatalogListeners.get(targetKey)?.forEach(listener => listener());
    setState({ targetKey, value: { phase: 'idle' } });
  }, [targetKey]);
  React.useEffect(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { generation: requestRef.current.generation + 1, controller: null };
  }, [targetKey]);
  React.useEffect(() => () => requestRef.current.controller?.abort(), []);
  return { catalog, lastKnownRows, requestCatalog, resetCatalog };
}
