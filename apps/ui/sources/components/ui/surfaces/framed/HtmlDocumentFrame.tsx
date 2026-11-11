import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierHtmlSandboxFrame } from '@happier-dev/plugin-ui/presentation';

import type { ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { normalizeUiSurfaceCapabilityRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { HostedFrameHost } from '@/components/ui/surfaces/framed/HostedFrameHost';

export type HtmlDocumentFrameState =
  | Readonly<{ phase: 'loading' | 'failed' }>
  | Readonly<{ phase: 'ready'; bundle: ArtifactHtmlBundleV1 }>;

/**
 * The one sandbox for HTML written by agents or other people (Artifacts, workspace files):
 * scripts run in an opaque origin with no host bridge, popups or top navigation, and network
 * only as the bundle's own saved policy allows (none when it states none).
 */
export function HtmlDocumentFrame(
  props: Readonly<{
    state: HtmlDocumentFrameState;
    /** Identity of the document version: a new key mounts a fresh guest. */
    frameKey: string;
    title: string;
    testID: string;
    frameTestID: string;
    onError: () => void;
    failure: React.ReactNode;
    loading: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const state = props.state;
  const requestedCapabilities =
    state.phase === 'ready' ? state.bundle.requestedCapabilities : undefined;
  const networkPolicy = React.useMemo(
    () => normalizeUiSurfaceCapabilityRequestV1(requestedCapabilities),
    [requestedCapabilities],
  );
  return (
    <HappierHtmlSandboxFrame
      testID={props.testID}
      title={props.title}
      backgroundColor={theme.colors.surface.elevated}
      state={state}
      onError={props.onError}
      failure={props.failure}
      loading={props.loading}
      host={{
        renderFrame: ({ title, onError, nativeStyle }) =>
          state.phase === 'ready' ? (
            <View style={nativeStyle}>
              <HostedFrameHost
                key={props.frameKey}
                title={title}
                bundle={state.bundle}
                network={
                  networkPolicy?.network === 'origins'
                    ? undefined
                    : (networkPolicy?.network ?? 'none')
                }
                networkOrigins={networkPolicy?.networkOrigins}
                testID={props.frameTestID}
                sandbox={{
                  scripts: true,
                  sameOrigin: false,
                  popups: false,
                  topNavigation: false,
                  mixedContent: false,
                }}
                security={{
                  allowedNavigationOrigins: [],
                  allowedCallbackOrigins: [],
                  allowedConnectOrigins: [],
                  csp: {
                    connectSrc: 'none',
                    allowDataUrls: true,
                    allowBlobUrls: false,
                    allowInlineStyles: true,
                    allowEval: false,
                  },
                  sourceMaps: 'disabled',
                  mixedContent: 'deny',
                }}
                onError={onError}
                onUnexpectedNavigation={onError}
                onNativeHostedHtmlUnavailable={onError}
              />
            </View>
          ) : null,
      }}
    />
  );
}
