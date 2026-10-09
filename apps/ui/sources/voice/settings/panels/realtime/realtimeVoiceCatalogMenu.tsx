import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceRemoteCatalogState } from '@/voice/settings/remoteCatalogState';

import {
  playRealtimeCatalogPreview,
  readRealtimeCatalogPreview,
  stopRealtimeCatalogPreview,
  subscribeRealtimeCatalogPreview,
} from './catalogPreview';
import { fetchVoiceSettingsCatalog, type VoiceCatalogRow } from './voiceCatalog';
import type { BundledConversationProviderClient } from '@/voice/credentials/bundledConversationClient';

const PREVIEW_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

export type RealtimeCatalogState = VoiceRemoteCatalogState<VoiceCatalogRow>;

/** The one catalog preview player per provider, shared by Settings and a Session's Work voice picker. */
export function useRealtimeCatalogPreview(providerId: string): Readonly<{
  previewingId: string | null;
  playPreview: (row: VoiceCatalogRow) => void;
  stopPreview: () => void;
}> {
  const snapshot = React.useSyncExternalStore(
    subscribeRealtimeCatalogPreview,
    readRealtimeCatalogPreview,
    readRealtimeCatalogPreview,
  );
  const previewingId =
    snapshot?.providerId === providerId ? snapshot.voiceId : null;
  const providerRef = React.useRef(providerId);
  providerRef.current = providerId;
  const stopPreview = React.useCallback(() => {
    stopRealtimeCatalogPreview(providerId);
  }, [providerId]);
  React.useEffect(() => stopPreview, [stopPreview]);
  const playPreview = React.useCallback(
    (row: VoiceCatalogRow) => {
      if (!row.previewUrl) return;
      if (previewingId === row.id) {
        stopPreview();
        return;
      }
      fireAndForget(
        playRealtimeCatalogPreview({
          providerId,
          row,
          isCurrent: () => providerRef.current === providerId,
        }),
        { tag: 'RealtimeCatalogPreview.play' },
      );
    },
    [previewingId, providerId, stopPreview],
  );
  return { previewingId, playPreview, stopPreview };
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
    onPreview: (row: VoiceCatalogRow) => void;
    inUseId?: string | null;
    category?: string;
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
    inUseId,
    category,
  } = params;
  return React.useMemo(() => {
    const catalogRows: DropdownMenuItem[] =
      catalog.phase === 'ready'
        ? catalog.rows.map((row) => {
            const inUse =
              inUseId !== undefined && inUseId !== null && inUseId === row.id;
            const preview = row.previewUrl ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(
                  'settingsVoice.realtimeProviders.catalog.preview',
                  { voice: row.name },
                )}
                style={{
                  minWidth: PREVIEW_TARGET_SIZE,
                  minHeight: PREVIEW_TARGET_SIZE,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onPress={(event) => {
                  event.stopPropagation();
                  onPreview(row);
                }}
              >
                <Icon
                  name={previewingId === row.id ? 'stop-circle' : 'play-circle'}
                  size={24}
                  color={theme.colors.text.secondary}
                />
              </Pressable>
            ) : null;
            return {
              id: row.id,
              title: row.name,
              subtitle: row.subtitle,
              ...(category ? { category } : {}),
              rightElement: inUse ? (
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <StatusPill
                    variant="neutral"
                    hideDot
                    label={t('sessionVoice.inUse')}
                    labelVariant="phrase"
                  />
                  {preview}
                </View>
              ) : (
                (preview ?? undefined)
              ),
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
                id: '__retry__',
                title: tLoose('settingsVoice.realtimeProviders.catalog.retry'),
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
    category,
    credentialUnavailableDetail,
    credentialUsable,
    inUseId,
    onPreview,
    previewingId,
    theme.colors.text.secondary,
  ]);
}

/**
 * The provider's voice catalog, fetched on demand (opening a picker) through its bundled client and
 * retained per `targetKey` (provider + credential): the one fetch owner for Settings and Work.
 */
export function useRealtimeVoiceCatalog(params: Readonly<{
  client: BundledConversationProviderClient | null;
  credentialUsable: boolean;
  targetKey: string;
}>): Readonly<{ catalog: RealtimeCatalogState; requestCatalog: () => void; resetCatalog: () => void }> {
  const { client, credentialUsable, targetKey } = params;
  const [state, setState] = React.useState<Readonly<{ targetKey: string; value: RealtimeCatalogState }> | null>(null);
  const catalog: RealtimeCatalogState = state?.targetKey === targetKey ? state.value : { phase: 'idle' };
  const requestRef = React.useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const requestCatalog = React.useCallback(() => {
    if (!client || !credentialUsable || catalog.phase === 'loading') return;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = requestRef.current.generation + 1;
    requestRef.current = { generation, controller };
    setState({ targetKey, value: { phase: 'loading' } });
    void fetchVoiceSettingsCatalog(client, controller.signal).then((rows) => {
      if (requestRef.current.generation === generation && !controller.signal.aborted) setState({ targetKey, value: { phase: 'ready', rows } });
    }).catch(() => {
      if (requestRef.current.generation === generation && !controller.signal.aborted) setState({ targetKey, value: { phase: 'error' } });
    });
  }, [catalog.phase, client, credentialUsable, targetKey]);
  const resetCatalog = React.useCallback(() => setState({ targetKey, value: { phase: 'idle' } }), [targetKey]);
  React.useEffect(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { generation: requestRef.current.generation + 1, controller: null };
  }, [targetKey]);
  React.useEffect(() => () => requestRef.current.controller?.abort(), []);
  return { catalog, requestCatalog, resetCatalog };
}
