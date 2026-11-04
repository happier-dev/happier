import * as React from 'react';
import { View } from 'react-native';

import type {
  BrowserDiagnosticsCookieExtraInfoV1,
  BrowserDiagnosticsCookieV1,
  BrowserDiagnosticsRequestDetailV1,
} from '@happier-dev/protocol/browser/diagnostics/v1';

import { Text } from '@/components/ui/text/Text';
import {
  useBrowserDiagnosticsRequestDetail,
  type UseBrowserDiagnosticsDaemonSnapshotInput,
} from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
  browserDiagnosticsPanelStyles as styles,
  DiagnosticsCodeBlock,
  sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

/** The page a request detail reads its bodies and cookies from; provided by the open drawer. */
export type BrowserDiagnosticsRequestDetailSource = Pick<
  UseBrowserDiagnosticsDaemonSnapshotInput,
  'view' | 'machineId' | 'serverId' | 'enabled'
> &
  Pick<Parameters<typeof useBrowserDiagnosticsRequestDetail>[0], 'detailClient'>;

export const BrowserDiagnosticsRequestDetailSourceContext =
  React.createContext<BrowserDiagnosticsRequestDetailSource | null>(null);

type BodyState = Extract<
  BrowserDiagnosticsRequestDetailV1,
  { status: 'available' }
>['requestBody'];

function bodyUnavailableCopy(
  reason: Extract<BodyState, { status: 'unavailable' }>['reason'],
): string {
  switch (reason) {
    case 'not_captured':
      return t('browserDiagnostics.host.devtools.request.bodyNotCaptured');
    case 'not_finished':
      return t('browserDiagnostics.host.devtools.request.bodyNotFinished');
    case 'body_unavailable':
      return t('browserDiagnostics.host.devtools.request.bodyGone');
  }
}

function detailUnavailableCopy(reason: string): string {
  switch (reason) {
    case 'permission_denied':
      return t('browserDiagnostics.host.devtools.request.ownerOnly');
    case 'request_evicted':
      return t('browserDiagnostics.host.devtools.request.evicted');
    case 'page_unavailable':
      return t('browserDiagnostics.host.devtools.request.pageGone');
    case 'unsupported_engine':
      return t('browserDiagnostics.host.devtools.request.unsupportedEngine');
    default:
      return t('browserDiagnostics.host.devtools.request.loadFailed');
  }
}

function BodyBlock(
  props: Readonly<{ label: string; body: BodyState; testID: string }>,
): React.ReactElement {
  if (props.body.status === 'unavailable') {
    return (
      <View testID={props.testID} style={styles.codeBlock}>
        <Text style={[styles.fieldLabel, styles.codeLabel]}>{props.label}</Text>
        <Text testID={`${props.testID}-reason`} style={styles.fieldLabel}>
          {bodyUnavailableCopy(props.body.reason)}
        </Text>
      </View>
    );
  }
  if (props.body.text.length === 0) {
    return (
      <View testID={props.testID} style={styles.codeBlock}>
        <Text style={[styles.fieldLabel, styles.codeLabel]}>{props.label}</Text>
        <Text style={styles.fieldLabel}>
          {t('browserDiagnostics.host.devtools.request.bodyEmpty')}
        </Text>
      </View>
    );
  }
  return (
    <DiagnosticsCodeBlock
      testID={props.testID}
      label={
        props.body.encoding === 'base64'
          ? t('browserDiagnostics.host.devtools.request.binaryBody', {
              label: props.label,
            })
          : props.label
      }
      text={props.body.text}
    />
  );
}

function cookieLine(cookie: BrowserDiagnosticsCookieV1): string {
  if (cookie.cookieLine) return cookie.cookieLine;
  return `${cookie.name ?? ''}=${cookie.value ?? ''}`;
}

function cookieFlags(cookie: BrowserDiagnosticsCookieV1): string {
  return [
    cookie.domain,
    cookie.path,
    cookie.httpOnly ? 'HttpOnly' : null,
    cookie.secure ? 'Secure' : null,
    cookie.sameSite ? `SameSite=${cookie.sameSite}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function CookieList(
  props: Readonly<{
    label: string;
    infos: readonly BrowserDiagnosticsCookieExtraInfoV1[];
    testID: string;
  }>,
): React.ReactElement | null {
  const cookies = props.infos.flatMap((info) => info.cookies);
  if (cookies.length === 0) return null;
  return (
    <View testID={props.testID} style={styles.codeBlock}>
      <Text style={[styles.fieldLabel, styles.codeLabel]}>{props.label}</Text>
      {cookies.map((cookie, index) => {
        const flags = cookieFlags(cookie);
        const blocked = cookie.blockedReasons.length > 0;
        return (
          <View
            key={`${cookie.name ?? 'cookie'}-${index}`}
            testID={`${props.testID}-${index}`}
            style={styles.plainList}
          >
            <Text selectable style={styles.codeText}>
              {cookieLine(cookie)}
            </Text>
            {flags ? <Text style={styles.fieldLabel}>{flags}</Text> : null}
            {blocked ? (
              <Text
                testID={`${props.testID}-${index}-blocked`}
                style={styles.fieldLabel}
              >
                {t('browserDiagnostics.host.devtools.request.cookieBlocked', {
                  reasons: cookie.blockedReasons.join(', '),
                })}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The selected request's bodies and cookies, read on demand: this leaf mounts only while the request's
 * detail is open, so a closed row never asks the daemon for values (owner B5/B6).
 */
function RequestExtrasLeaf(
  props: Readonly<{
    source: BrowserDiagnosticsRequestDetailSource;
    requestId: string;
    testID: string;
  }>,
): React.ReactElement {
  const state = useBrowserDiagnosticsRequestDetail({
    view: props.source.view,
    machineId: props.source.machineId,
    serverId: props.source.serverId,
    enabled: props.source.enabled,
    detailClient: props.source.detailClient,
    selectedRequestId: props.requestId,
  });
  if (state.status === 'idle') return <View testID={`${props.testID}-idle`} />;
  if (state.status === 'loading') {
    return (
      <Text testID={`${props.testID}-loading`} style={styles.fieldLabel}>
        {t('browserDiagnostics.host.devtools.request.loading')}
      </Text>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <Text testID={`${props.testID}-unavailable`} style={styles.fieldLabel}>
        {detailUnavailableCopy(state.reason)}
      </Text>
    );
  }
  return (
    <View testID={props.testID} style={styles.plainList}>
      <BodyBlock
        testID={`${props.testID}-requestBody`}
        label={t('browserDiagnostics.host.devtools.fields.requestBody')}
        body={state.requestBody}
      />
      <BodyBlock
        testID={`${props.testID}-responseBody`}
        label={t('browserDiagnostics.host.devtools.fields.responseBody')}
        body={state.responseBody}
      />
      <CookieList
        testID={`${props.testID}-requestCookies`}
        label={t('browserDiagnostics.host.devtools.request.requestCookies')}
        infos={state.requestExtraInfo}
      />
      <CookieList
        testID={`${props.testID}-responseCookies`}
        label={t('browserDiagnostics.host.devtools.request.responseCookies')}
        infos={state.responseExtraInfo}
      />
    </View>
  );
}

export function BrowserNetworkRequestExtras(
  props: Readonly<{ requestId: string | null; testID: string }>,
): React.ReactElement | null {
  const source = React.useContext(BrowserDiagnosticsRequestDetailSourceContext);
  if (!source?.view || !props.requestId) return null;
  return (
    <RequestExtrasLeaf
      source={source}
      requestId={props.requestId}
      testID={`${props.testID}-extras-${sanitizeTestIdPart(props.requestId)}`}
    />
  );
}
