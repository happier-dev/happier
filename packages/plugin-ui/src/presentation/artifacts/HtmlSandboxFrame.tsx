import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import type { HappierPortableStyle } from '../portableTypes.js';

export type HappierHtmlSandboxFrameHost = Readonly<{
  renderFrame(input: Readonly<{ url: string; title: string; onError(): void; webStyle: CSSProperties; nativeStyle: HappierPortableStyle }>): ReactNode;
}>;
export type HappierHtmlSandboxFrameProps = Readonly<{
  state: Readonly<{ phase: 'loading' | 'failed' }> | Readonly<{ phase: 'ready'; url: string }>;
  title: string;
  backgroundColor: string;
  loading: ReactNode;
  failure: ReactNode;
  onError(): void;
  host: HappierHtmlSandboxFrameHost;
  testID?: string;
}>;

/** Shared reading-area geometry, not a sandbox policy. The host admits URLs and renders its secured platform frame. */
export function HappierHtmlSandboxFrame(props: HappierHtmlSandboxFrameProps): ReactElement {
  return <View testID={props.testID} style={{ height: 560, minHeight: 0, backgroundColor: props.backgroundColor }}>
    {props.state.phase === 'ready' ? props.host.renderFrame({
      url: props.state.url, title: props.title, onError: props.onError,
      webStyle: { width: '100%', height: '100%', border: 0 },
      nativeStyle: { flex: 1, backgroundColor: props.backgroundColor },
    }) : props.state.phase === 'failed' ? props.failure : props.loading}
  </View>;
}
