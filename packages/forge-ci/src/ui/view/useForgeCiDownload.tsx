import * as React from 'react';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import {
  Banner,
  usePluginHostApi,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import { readForgeOperationStateV1 } from '../operationState.js';
import type { ForgeCiBindingV1 } from './binding.js';
import { ForgeCiStateNotice } from './ForgeCiStateNotice.js';

type DownloadRequest = Parameters<
  ReturnType<typeof usePluginHostApi>['downloadFile']
>[0];

export type ForgeCiDownloadStateV1 = Readonly<{
  /** The key of the download in flight (an artifact id, `log`); one at a time per surface. */
  pending: string | null;
  last: Readonly<{
    key: string;
    label: string;
    result: FileDownloadResultV1;
  }> | null;
}>;

/**
 * Downloads to this device through the host (D-I6): the provider Action runs as the present person, and the
 * closed result is kept — accepted is not saved bytes, a lost answer stays unknown and is never re-requested.
 */
export function useForgeCiDownloadV1() {
  const host = usePluginHostApi();
  const [state, setState] = useState<ForgeCiDownloadStateV1>({
    pending: null,
    last: null,
  });
  const inFlight = useRef(false);
  const download = useCallback(
    async (key: string, label: string, request: DownloadRequest) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setState((previous) => ({ pending: key, last: previous.last }));
      try {
        const result = await host.downloadFile(request);
        setState({ pending: null, last: { key, label, result } });
      } catch (error) {
        // A thrown host call never proved whether bytes moved: unknown, not failed.
        setState({
          pending: null,
          last: {
            key,
            label,
            result: { success: false, status: 'unknown', error: String(error) },
          },
        });
      } finally {
        inFlight.current = false;
      }
    },
    [host],
  );
  return { state, download };
}

/** One line for a download that did not complete; nothing for accepted, completed or a cancel the person chose. */
export function ForgeCiDownloadNotice({
  ci,
  state,
  targetUrl,
}: Readonly<{
  ci: ForgeCiBindingV1;
  state: ForgeCiDownloadStateV1;
  targetUrl?: string | null;
}>): ReactElement | null {
  const t = usePluginTranslation();
  const last = state.last;
  if (!last || last.result.success || last.result.status === 'cancelled')
    return null;
  if (last.result.status === 'unknown') {
    return (
      <ForgeCiStateNotice
        presentation="banner"
        about={{ ...ci.about, subject: last.label }}
        state={readForgeOperationStateV1({
          download: last.result,
          account: ci.account,
          hasRetainedValue: true,
          targetUrl: targetUrl ?? null,
        })}
      />
    );
  }
  return (
    <Banner
      tone="danger"
      title={t('forgeCi.download.failed', 'Couldn’t download {name}', {
        name: last.label,
      })}
      description={t(
        'forgeCi.download.failed.body',
        'Nothing was saved on this device. You can try again.',
      )}
    />
  );
}
