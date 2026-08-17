import type { ReactElement, ReactNode } from 'react';

import { HappierInfoState, HappierInfoTile } from '../presentation/state/InfoState.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { Spinner } from './Spinner.js';

const STATE_LOADING_TRANSLATION_KEY = 'happier.plugin-ui.state.loading';
const STATE_EMPTY_TRANSLATION_KEY = 'happier.plugin-ui.state.empty';
const STATE_ERROR_TRANSLATION_KEY = 'happier.plugin-ui.state.error';

export type PluginUiResourceState<Value = unknown> =
  | Readonly<{ status: 'idle' | 'loading' }>
  | Readonly<{ status: 'ready'; value: Value }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'unavailable' | 'stale' | 'complete'; diagnostics?: readonly string[] }>
  | Readonly<{ status: 'error'; code?: string; message?: string; diagnostics?: readonly string[] }>;

/**
 * The three resolvable presentations of a resource, rendered as real components
 * (UI-T27) rather than the inert `happier-plugin-state` marker the predecessor
 * shipped.
 *
 * All three are adapters over ONE shared implementation (`HappierInfoState`),
 * which Happier core's `EmptyState` renders too. They differ only in what goes
 * in the leading slot and which semantic tone the title carries — never in
 * layout, measure or spacing, which is exactly the drift two implementations
 * would have produced.
 */
type StateCopyProps = Readonly<{
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  /** A call to action rendered below the copy. */
  action?: ReactNode;
  testID?: string;
}>;

export type LoadingStateProps = StateCopyProps;
export type EmptyStateProps = StateCopyProps;
export type ErrorStateProps = StateCopyProps;

function useResolvedCopy({ title, titleKey, description, descriptionKey }: StateCopyProps) {
  const translate = usePluginTranslation();
  return {
    translate,
    title: resolveAuthorText(translate, title, titleKey),
    description: resolveAuthorText(translate, description, descriptionKey),
  };
}

/**
 * Work is in progress.
 *
 * The spinner carries the title as its accessible name when there is one, so a
 * screen-reader user learns WHAT is loading rather than only that something is.
 */
export function LoadingState(props: LoadingStateProps): ReactElement {
  const { translate, title, description } = useResolvedCopy(props);

  return (
    <HappierInfoState testID={props.testID} action={props.action}>
      <HappierInfoTile
        icon={<Spinner accessibilityLabel={title ?? translate(STATE_LOADING_TRANSLATION_KEY, 'Loading')} />}
        title={title}
        description={description}
      />
    </HappierInfoState>
  );
}

/** The resource resolved, and there is genuinely nothing to show. */
export function EmptyState(props: EmptyStateProps): ReactElement {
  const { title, description } = useResolvedCopy(props);

  return (
    <HappierInfoState testID={props.testID} action={props.action}>
      <HappierInfoTile title={title} description={description} />
    </HappierInfoState>
  );
}

/** The resource could not be resolved. */
export function ErrorState(props: ErrorStateProps): ReactElement {
  const { title, description } = useResolvedCopy(props);

  return (
    <HappierInfoState
      testID={props.testID}
      action={props.action}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <HappierInfoTile tone="danger" title={title} description={description} />
    </HappierInfoState>
  );
}

export type StateProps<Value> = Readonly<{
  resource?: PluginUiResourceState<Value>;
  /** Replaces the default {@link LoadingState}. */
  loading?: ReactNode;
  /** Replaces the default {@link EmptyState}. */
  empty?: ReactNode;
  /** Replaces the default {@link ErrorState}. */
  error?: ReactNode | ((state: Extract<PluginUiResourceState<Value>, { status: 'error' }>) => ReactNode);
  children?: ReactNode | ((value: Value) => ReactNode);
}>;

/**
 * Render exactly one presentation for a resource snapshot.
 *
 * Every non-ready status resolves to a real component. The predecessor wrapped
 * whatever the author supplied in an inert marker element and rendered NOTHING
 * when a slot was omitted, so a surface waiting on a resource showed a blank
 * area. Framework-owned defaults resolve through the host's translation
 * projection; their English fallbacks keep isolated and older hosts readable.
 */
export function State<Value>({
  resource,
  loading,
  empty,
  error,
  children,
}: StateProps<Value>): ReactElement | null {
  const translate = usePluginTranslation();
  if (!resource || resource.status === 'idle' || resource.status === 'loading') {
    return <>{loading ?? <LoadingState />}</>;
  }
  if (resource.status === 'empty') {
    return <>{empty ?? <EmptyState title={translate(STATE_EMPTY_TRANSLATION_KEY, 'Nothing to show')} />}</>;
  }
  if (resource.status === 'error') {
    if (error !== undefined) {
      return <>{typeof error === 'function' ? error(resource) : error}</>;
    }
    return <ErrorState title={translate(STATE_ERROR_TRANSLATION_KEY, 'Something went wrong')} />;
  }
  if (resource.status === 'ready') {
    return <>{typeof children === 'function' ? children(resource.value) : children}</>;
  }
  // `unavailable` / `stale` / `complete` carry no value, so a render-prop child
  // has nothing to receive; a static child still describes the surface.
  return <>{typeof children === 'function' ? null : children}</>;
}
