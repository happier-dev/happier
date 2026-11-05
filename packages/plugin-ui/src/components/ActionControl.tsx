import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type {
  PluginUiActionReference,
  PluginUiActionControl,
  PluginUiActionControlController,
  PluginUiActionControlPresentation,
} from '@happier-dev/plugin-sdk/ui';
import { PluginError, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { usePluginHostApi } from '../hostApi/context.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type ActionControlProps = Readonly<{
  action: PluginUiActionReference;
  /** Fresh preparation and original execution settlement; never a person-authorized executor. */
  controller: PluginUiActionControlController;
  title?: string;
  titleKey?: string;
  variant?: PluginUiActionControlPresentation['variant'];
  disabled?: boolean;
  signal?: PluginCancellationOptions['signal'];
  /** Unsupported or withdrawn hosts keep the author's explanation, with no raw-execution fallback. */
  fallback?: ReactNode;
  onUnavailable?: (error: unknown) => void;
}>;

/**
 * Registers a control in the mounted host's action slot, outside the author
 * tree (and outside the iframe on hosted-web). The host owns the physical
 * button. Presentation updates do not replace the controller preparing a run.
 */
export function ActionControl(props: ActionControlProps): ReactNode {
  const host = usePluginHostApi();
  const translate = usePluginTranslation();
  const title = resolveAuthorText(translate, props.title, props.titleKey)
    ?? translate('happier.plugin-ui.action.execute', 'Run');
  const { disabled, variant, signal } = props;
  const actionKey = typeof props.action === 'string' ? JSON.stringify(props.action)
    : JSON.stringify([props.action.pluginId, props.action.localId]);
  const nextPresentation: PluginUiActionControlPresentation = {
    title,
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
    }, { signal: lifetime.signal }).then(control => {
      if (lifetime.signal.aborted) { control.dispose(); return; }
      mounted = control;
      binding.current = control;
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
  }, [host, actionKey, signal, title, disabled, variant]);

  return unavailable ? props.fallback ?? null : null;
}
