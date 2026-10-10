import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageActionPorts } from '@happier-dev/protocol/actions/executor/usageActions';
import type { UsageRecapComposed } from '@happier-dev/protocol';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { captureUsageViewPng } from '../../usageAnalyticsExport';
import { UsageStatCard } from './UsageStatCard';
import { buildUsageStatCardModel } from './usageStatCardModel';

type RenderResult = Awaited<ReturnType<NonNullable<UsageActionPorts['renderRecap']>>>;

/** A client-only mounted renderer, never an upload, clipboard or share operation. */
export const renderUsageRecapImage: NonNullable<UsageActionPorts['renderRecap']> = (compose, context) => {
  if (context.signal?.aborted) return Promise.resolve({ kind: 'unavailable', reason: 'render_target_unavailable' });
  return new Promise(resolve => {
    let modalId = '';
    let settled = false;
    const finish = (result: RenderResult) => {
      if (settled) return;
      settled = true;
      context.signal?.removeEventListener('abort', cancel);
      if (modalId) Modal.hide(modalId);
      resolve(result);
    };
    const cancel = () => finish({ kind: 'unavailable', reason: 'render_target_unavailable' });
    context.signal?.addEventListener('abort', cancel, { once: true });
    modalId = Modal.show({
      component: UsageRecapImageStage,
      props: { compose, signal: context.signal, finish },
      onRequestClose: cancel,
      onHostUnmount: cancel,
      chrome: { kind: 'card', material: 'solid', title: t('usage.board.recap.composing'),
        dimensions: { size: 'lg' }, testID: 'usage-recap-image.modal' },
    });
    if (!modalId) cancel();
    else if (settled) Modal.hide(modalId);
  });
};

function UsageRecapImageStage(props: Readonly<{
  compose: UsageRecapComposed;
  signal?: AbortSignal;
  finish: (result: RenderResult) => void;
}> & CustomModalInjectedProps): React.ReactElement {
  const { theme } = useUnistyles();
  const card = React.useRef<View>(null);
  const capturing = React.useRef(false);
  const model = React.useMemo(() => buildUsageStatCardModel(props.compose), [props.compose]);
  React.useEffect(() => () => props.finish({ kind: 'unavailable', reason: 'render_target_unavailable' }), [props.finish]);
  const capture = React.useCallback(() => {
    if (capturing.current || !card.current) return;
    capturing.current = true;
    void captureUsageViewPng(card.current, { signal: props.signal }).then(
      base64 => props.finish({ kind: 'rendered', base64 }),
      () => props.finish({ kind: 'unavailable', reason: 'render_failed' }),
    );
  }, [props.signal, props.finish]);
  return <View onLayout={capture} testID="usage-recap-image.stage">
    <UsageStatCard ref={card} model={model} tone={theme.dark ? 'dark' : 'light'} testID="usage-recap-image.card" />
  </View>;
}
