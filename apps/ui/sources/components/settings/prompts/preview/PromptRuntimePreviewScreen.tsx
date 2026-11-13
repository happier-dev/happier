import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SessionPromptPreviewV1Response } from '@happier-dev/protocol';

import type { SessionSelectionIdentity } from '@/components/sessions/selection/SessionSelectionModal';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { sessionPromptPreview } from '@/sync/ops/sessionPromptPreview';
import { t } from '@/text';

import { openPromptRuntimePreviewSessionSelectionModal } from './openPromptRuntimePreviewSessionSelectionModal';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    paddingVertical: 12,
    maxWidth: layout.maxWidth,
    width: '100%',
    alignSelf: 'center',
  },
}));

export const PromptRuntimePreviewScreen = React.memo(function PromptRuntimePreviewScreen(props: Readonly<{
  initialSelection?: SessionSelectionIdentity | null;
}>) {
  const { theme } = useUnistyles();
  const [selection, setSelection] = React.useState<SessionSelectionIdentity | null>(props.initialSelection ?? null);
  const [preview, setPreview] = React.useState<SessionPromptPreviewV1Response | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const requestIdRef = React.useRef(0);
  const loadedInitialSelectionRef = React.useRef(false);

  const loadPreview = React.useCallback(async (target: SessionSelectionIdentity) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setFailed(false);
    setPreview(null);
    try {
      const next = await sessionPromptPreview({ sessionId: target.sessionId, serverId: target.serverId });
      if (requestId === requestIdRef.current) setPreview(next);
    } catch {
      if (requestId === requestIdRef.current) setFailed(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  const selectSession = React.useCallback(async () => {
    const nextSelection = await openPromptRuntimePreviewSessionSelectionModal();
    if (!nextSelection) return;
    setSelection(nextSelection);
    await loadPreview(nextSelection);
  }, [loadPreview]);

  React.useEffect(() => {
    if (!props.initialSelection || loadedInitialSelectionRef.current) return;
    loadedInitialSelectionRef.current = true;
    void loadPreview(props.initialSelection);
  }, [loadPreview, props.initialSelection]);

  return (
    <View style={styles.container}>
      <ItemList containerStyle={styles.content}>
        <ItemGroup
          title={t('promptLibrary.runtimePreview')}
          footer={t('promptLibrary.runtimePreviewExplanation')}
        >
          <Item
            testID="prompt-runtime-preview-session"
            title={t('promptLibrary.runtimePreviewSession')}
            subtitle={selection?.sessionId ?? t('promptLibrary.runtimePreviewChooseSession')}
            icon={<Icon name="chat-circle" size={29} color={theme.colors.accent.blue} />}
            onPress={selectSession}
          />
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.runtimePreviewResult')}>
          {!selection ? (
            <Item
              testID="prompt-runtime-preview-state"
              mode="info"
              title={t('promptLibrary.runtimePreviewAwaitingSession')}
              subtitle={t('promptLibrary.runtimePreviewAwaitingSessionSubtitle')}
              icon={<Icon name="eye" size={29} color={theme.colors.text.secondary} />}
            />
          ) : loading ? (
            <Item
              testID="prompt-runtime-preview-state"
              mode="info"
              loading
              title={t('promptLibrary.runtimePreviewLoading')}
              subtitle={t('promptLibrary.runtimePreviewLoadingSubtitle')}
              icon={<Icon name="eye" size={29} color={theme.colors.text.secondary} />}
            />
          ) : failed ? (
            <Item
              testID="prompt-runtime-preview-state"
              title={t('promptLibrary.runtimePreviewError')}
              subtitle={t('promptLibrary.runtimePreviewErrorSubtitle')}
              icon={<Icon name="warning-circle" size={29} color={theme.colors.accent.orange} />}
              onPress={() => { void loadPreview(selection); }}
            />
          ) : preview ? (
            <>
              <Item
                testID="prompt-runtime-preview-rendered-text"
                mode="info"
                title={t('promptLibrary.runtimePreviewRenderedText')}
                subtitle={preview.text || t('promptLibrary.runtimePreviewRenderedTextEmpty')}
                subtitleLines={0}
                icon={<Icon name="text-aa" size={29} color={theme.colors.accent.indigo} />}
              />
              <Item
                testID="prompt-runtime-preview-launch-form"
                mode="info"
                title={t('promptLibrary.runtimePreviewLaunchForm')}
                subtitle={t(preview.launchForm === 'fresh'
                  ? 'promptLibrary.runtimePreviewLaunchFormFresh'
                  : 'promptLibrary.runtimePreviewLaunchFormRetained')}
                icon={<Icon name="rocket" size={29} color={theme.colors.accent.blue} />}
              />
            </>
          ) : null}
        </ItemGroup>

        {preview ? (
          <ItemGroup title={t('promptLibrary.runtimePreviewBlocks')}>
            {preview.blocks.map((block) => (
              <Item
                key={`${block.id}:${block.scope}`}
                mode="info"
                title={block.id}
                subtitle={t('promptLibrary.runtimePreviewBlockDetails', {
                  scope: block.scope,
                  chars: block.chars.toLocaleString(),
                })}
                icon={<Icon name="code" size={29} color={theme.colors.text.secondary} />}
              />
            ))}
          </ItemGroup>
        ) : null}

        {preview?.providerNotes.length ? (
          <ItemGroup title={t('promptLibrary.runtimePreviewProviderNotes')}>
            {preview.providerNotes.map((note, index) => (
              <Item
                key={`${index}:${note}`}
                mode="info"
                title={note}
                titleLines={0}
                icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
              />
            ))}
          </ItemGroup>
        ) : null}
      </ItemList>
    </View>
  );
});
