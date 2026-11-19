import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type {
  PluginUiActionReference,
  PluginUiActionControl,
  PluginUiActionControlController,
  PluginUiActionControlPresentation,
} from '@happier-dev/plugin-sdk/ui';
import { PluginError, type JsonValue, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { usePluginHostApi } from '../hostApi/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type ActionControlProps = Readonly<{
  action: PluginUiActionReference;
  /** Fresh preparation and original execution settlement; never a person-authorized executor. */
  controller: PluginUiActionControlController;
  /** Operands displayed by a host-supported in-place review. The host admits the confirm press. */
  reviewedInput?: JsonValue;
  title?: string;
  titleKey?: string;
  accessibilityLabel?: string;
  variant?: PluginUiActionControlPresentation['variant'];
  disabled?: boolean;
  signal?: PluginCancellationOptions['signal'];
  /** Unsupported or withdrawn hosts keep the author's explanation, with no raw-execution fallback. */
  fallback?: ReactNode;
  onUnavailable?: (error: unknown) => void;
}>;

/**
 * Registers a host-owned control. A same-realm host draws its button here, inside whatever
 * presentation hosts this declaration; a framed carrier (hosted-web) keeps it in the mount's slot
 * outside the iframe. The host owns the physical button either way. Presentation updates do not
 * replace the controller preparing a run.
 */
export function ActionControl(props: ActionControlProps): ReactNode {
  const host = usePluginHostApi();
  const renderInline = useOptionalPluginUiPresentationHost()?.renderActionControl;
  const translate = usePluginTranslation();
  const title = resolveAuthorText(translate, props.title, props.titleKey)
    ?? translate('happier.plugin-ui.action.execute', 'Run');
  const { accessibilityLabel, disabled, variant, signal } = props;
  const actionKey = typeof props.action === 'string' ? JSON.stringify(props.action)
    : JSON.stringify([props.action.pluginId, props.action.localId]);
  const nextPresentation: PluginUiActionControlPresentation = {
    title,
    ...(accessibilityLabel === undefined ? {} : { accessibilityLabel }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(variant === undefined ? {} : { variant }),
  };
  const latest = useRef(props);
  const presentation = useRef(nextPresentation);
  useLayoutEffect(() => {
    latest.current = props;
    presentation.current = nextPresentation;
  });
  const binding = useRef<PluginUiActionControl | null>(null);
  const [bound, setBound] = useState<PluginUiActionControl | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useLayoutEffect(() => {
    const lifetime = new AbortController();
    let mounted: PluginUiActionControl | undefined;
    // Settlement returns to the controller that prepared this invocation, even
    // if the author's current controller changes before the response arrives.
    let preparing = latest.current.controller;
    const retire = () => {
      lifetime.abort();
      if (binding.current === mounted) binding.current = null;
      setBound(null);
      mounted?.dispose();
    };
    signal?.addEventListener('abort', retire, { once: true });
    if (signal?.aborted) lifetime.abort();
    setUnavailable(false);
    if (!host.version().methods.includes('actionControl')) {
      setUnavailable(true);
      latest.current.onUnavailable?.(new PluginError({ code: 'unsupported_method' }));
      return () => { signal?.removeEventListener('abort', retire); retire(); };
    }
    void host.actionControl({ action: latest.current.action, presentation: presentation.current }, {
      prepare(options) {
        preparing = latest.current.controller;
        return preparing.prepare(options);
      },
      onSettled(execution) { preparing.onSettled(execution); },
    }, { signal, withdrawalSignal: lifetime.signal }).then(control => {
      if (lifetime.signal.aborted) { control.dispose(); return; }
      mounted = control;
      binding.current = control;
      setBound(control);
      // A render can update the presentation while admission is pending.
      void control.update(presentation.current).catch(error => {
        if (lifetime.signal.aborted) return;
        setUnavailable(true);
        latest.current.onUnavailable?.(error);
      });
    }, error => {
      if (lifetime.signal.aborted) return;
      setUnavailable(true);
      latest.current.onUnavailable?.(error);
    });
    return () => { signal?.removeEventListener('abort', retire); retire(); };
  }, [host, actionKey, signal]);

  useEffect(() => {
    const control = binding.current;
    if (!control) return;
    let active = true;
    void control.update(presentation.current).catch(error => {
      if (!active) return;
      setUnavailable(true);
      latest.current.onUnavailable?.(error);
    });
    return () => { active = false; };
  }, [host, actionKey, signal, title, accessibilityLabel, disabled, variant]);

  if (unavailable) return props.fallback ?? null;
  return renderInline ? renderInline({ control: bound, presentation: nextPresentation, reviewedInput: props.reviewedInput }) : null;
}

// The host draws it as a labelled button: in a stretching column it keeps its own width (`isHappierInlineControl`).
ActionControl.happierInlineControl = true as const;
