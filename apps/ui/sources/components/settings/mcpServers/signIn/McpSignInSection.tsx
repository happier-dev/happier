import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MCP_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { QRCode } from '@/components/qr';
import { ConnectedAccountOAuthForm } from '@/components/settings/connectedServices/account/ConnectedAccountOAuthForm';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import type { McpServerSignIn, McpSignInView } from './useMcpServerSignIn';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

type Props = Readonly<{
  testID?: string;
  name: string;
  signIn: Pick<
    McpServerSignIn,
    'start' | 'cancel' | 'complete' | 'signOut' | 'busy'
  > &
    Readonly<{ view: McpSignInView }>;
  /** Client refused: the Configuration's headers can carry an API key instead. */
  onUseApiKey?: () => void;
}>;

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(ms);
}

function formatLeft(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Minutes and seconds left on the authorization link, ticking once a second while shown. */
function useTimeLeft(expiresAtMs: number): string {
  const [now, setNow] = React.useState(() => Date.now());
  const presented = useLayoutPresentationActive();
  const viewed = useHostActivelyViewed();
  const active = presented && viewed;
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs, active]);
  return formatLeft(expiresAtMs - now);
}

function SigningTimeLeft(props: Readonly<{ expiresAtMs: number }>) {
  const left = useTimeLeft(props.expiresAtMs);
  return <Text variant="meta" style={stylesheet.meta}>
    {t('capabilities.mcpSignIn.timeLeft', { time: left })}
  </Text>;
}

/** The words, the one action and its weight, for every state but the in-flight ones. */
function Resting(
  props: Readonly<{
    testID: string;
    chip?: CapabilityStatus;
    title?: string;
    body: string;
    action?: Readonly<{
      label: string;
      display: 'default' | 'secondary' | 'inverted';
      onPress: () => void;
      disabled?: boolean;
      loading?: boolean;
    }>;
    leading?: React.ReactNode;
    footer?: React.ReactNode;
  }>,
) {
  const styles = stylesheet;
  return (
    <SectionContentRow testID={props.testID}>
      <View style={styles.resting}>
        <View style={styles.restingText}>
          {props.chip ? <CapabilityStatusChip status={props.chip} /> : null}
          {props.title ? (
            <View style={styles.titleRow}>
              {props.leading}
              <Text variant="label" emphasis="semiBold" style={styles.title}>
                {props.title}
              </Text>
            </View>
          ) : null}
          <Text variant="body" style={styles.body}>
            {props.body}
          </Text>
          {props.footer}
        </View>
        {props.action ? (
          <RoundButton
            testID={`${props.testID}:action`}
            size="small"
            display={props.action.display}
            title={props.action.label}
            onPress={props.action.onPress}
            disabled={props.action.disabled}
            loading={props.action.loading}
          />
        ) : null}
      </View>
    </SectionContentRow>
  );
}

/** Signing in: the button became the wait; the browser, a phone or a pasted answer finishes it. */
function Signing(
  props: Readonly<{
    testID: string;
    name: string;
    authorizationUrl: string;
    expiresAtMs: number;
    signIn: Props['signIn'];
  }>,
) {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const [mode, setMode] = React.useState<'browser' | 'phone' | 'paste'>(
    'browser',
  );
  const [copied, setCopied] = React.useState(false);
  const writeClipboard = useClipboardWrite();
  const copyLink = React.useCallback(async () => {
    setCopied(await writeClipboard(props.authorizationUrl));
  }, [props.authorizationUrl, writeClipboard]);
  const waiting = (label: string, trailing?: React.ReactNode) => (
    <View style={styles.waitingRow}>
      <ActivitySpinner size="small" />
      <Text
        variant="body"
        style={styles.waiting}
        accessibilityLiveRegion="polite"
      >
        {label}
      </Text>
      {trailing}
    </View>
  );
  if (mode === 'paste') {
    return (
      <SectionContentRow testID={`${props.testID}:paste`}>
        <View style={styles.stack}>
          <Text variant="label" emphasis="semiBold" style={styles.title}>
            {t('capabilities.mcpSignIn.pasteTitle')}
          </Text>
          <Text variant="body" style={styles.body}>
            {t('capabilities.mcpSignIn.pasteBody')}
          </Text>
          <ConnectedAccountOAuthForm
            embedded
            authorizationUrl={props.authorizationUrl}
            callbackUrl={MCP_OAUTH_CALLBACK_URL_V1}
            submitting={false}
            onCancel={() => setMode('browser')}
            onSubmit={props.signIn.complete}
          />
        </View>
      </SectionContentRow>
    );
  }
  if (mode === 'phone') {
    return (
      <SectionContentRow testID={`${props.testID}:phone`}>
        <View style={styles.phone}>
          <View style={styles.qr}>
            <QRCode data={props.authorizationUrl} size={168} />
          </View>
          <View style={styles.stack}>
            <Text variant="label" emphasis="semiBold" style={styles.title}>
              {t('capabilities.mcpSignIn.phoneTitle')}
            </Text>
            <Text variant="body" style={styles.body}>
              {t('capabilities.mcpSignIn.phoneBody')}
            </Text>
            {waiting(
              t('capabilities.mcpSignIn.phoneWaiting'),
              <SigningTimeLeft expiresAtMs={props.expiresAtMs} />,
            )}
            <View style={styles.links}>
              <Link
                testID={`${props.testID}:this-device`}
                label={t('capabilities.mcpSignIn.useThisDevice')}
                onPress={() => setMode('browser')}
              />
              <Link
                testID={`${props.testID}:cancel`}
                label={t('capabilities.mcpSignIn.cancel')}
                onPress={() => void props.signIn.cancel()}
              />
            </View>
          </View>
        </View>
      </SectionContentRow>
    );
  }
  return (
    <>
      <SectionContentRow testID={props.testID}>
        <View style={styles.stack}>
          <Text variant="label" emphasis="semiBold" style={styles.title}>
            {t('capabilities.mcpSignIn.signingTitle')}
          </Text>
          <Text variant="body" style={styles.body}>
            {t('capabilities.mcpSignIn.signingBody', { name: props.name })}
          </Text>
          {waiting(
            t('capabilities.mcpSignIn.waiting', { name: props.name }),
            <RoundButton
              testID={`${props.testID}:cancel`}
              size="small"
              display="inverted"
              title={t('capabilities.mcpSignIn.cancel')}
              onPress={() => void props.signIn.cancel()}
            />,
          )}
        </View>
      </SectionContentRow>
      <SectionContentRow testID={`${props.testID}:elsewhere`}>
        <View style={styles.elsewhere}>
          <Icon
            name="device-mobile"
            size={16}
            color={theme.colors.text.tertiary}
          />
          <Text variant="body" style={styles.elsewhereText}>
            {t('capabilities.mcpSignIn.notSignedInHere', { name: props.name })}{' '}
            <Text
              variant="body"
              emphasis="semiBold"
              style={styles.inlineLink}
              onPress={() => setMode('phone')}
              testID={`${props.testID}:use-phone`}
            >
              {t('capabilities.mcpSignIn.usePhone')}
            </Text>
            {` ${t('capabilities.mcpSignIn.or')} `}
            <Text
              variant="body"
              emphasis="semiBold"
              style={styles.inlineLink}
              onPress={() => void copyLink()}
              testID={`${props.testID}:copy-link`}
            >
              {copied
                ? t('capabilities.mcpSignIn.linkCopied')
                : t('capabilities.mcpSignIn.copyLink')}
            </Text>
          </Text>
        </View>
        <Link
          testID={`${props.testID}:got-code`}
          label={t('capabilities.mcpSignIn.pasteTitle')}
          onPress={() => setMode('paste')}
          quiet
        />
      </SectionContentRow>
    </>
  );
}

function Link(
  props: Readonly<{
    testID: string;
    label: string;
    onPress: () => void;
    quiet?: boolean;
    disabled?: boolean;
  }>,
) {
  const styles = stylesheet;
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="link"
      
      disabled={props.disabled}
      onPress={props.onPress}
      style={props.quiet ? styles.quietLinkBox : undefined}
    >
      {(state) => (
        <Text
          variant="meta"
          emphasis={props.quiet ? undefined : 'semiBold'}
          style={[
            props.quiet ? styles.quietLink : styles.link,
            // react-native-web adds hovered to the Pressable state.
            (state as Readonly<{ hovered?: boolean }>).hovered === true ? styles.linkHover : null,
          ]}
        >
          {props.label}
        </Text>
      )}
    </HappierPressable>
  );
}

/**
 * The server page's Sign-in section (T2, lab ms-B / ms-R): one sheet, one state at a time, one action.
 * The grant belongs to the Account, so the copy speaks of every machine; the button becomes the wait.
 */
export function McpSignInSection(props: Props) {
  const writeClipboard = useClipboardWrite();
  const { view } = props.signIn;
  const testID = props.testID ?? 'mcp.server.signin';
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const { name, signIn } = props;
  const [editingApp, setEditingApp] = React.useState(false);
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [callbackCopied, setCallbackCopied] = React.useState(false);
  React.useEffect(() => {
    if (view.state === 'signing' || view.state === 'connected') {
      setClientSecret('');
      setEditingApp(false);
    }
  }, [view.state]);
  const signOut = React.useCallback(async () => {
    if (!(await signIn.signOut()))
      Modal.alert(
        t('capabilities.mcpSignIn.signOut'),
        t('capabilities.mcpSignIn.signOutFailed'),
      );
  }, [signIn]);

  let body: React.ReactNode;
  switch (view.state) {
    case 'not_connected':
    case 'starting':
      body = (
        <Resting
          testID={`${testID}:not-connected`}
          title={t('capabilities.mcpSignIn.notConnectedTitle', { name })}
          body={t('capabilities.mcpSignIn.notConnectedBody', { name })}
          action={{
            label: t('capabilities.mcpSignIn.signIn'),
            display: 'default',
            loading: view.state === 'starting',
            disabled: view.state === 'starting',
            onPress: () => void signIn.start(),
          }}
        />
      );
      break;
    case 'signing':
      body = (
        <Signing
          testID={`${testID}:signing`}
          name={name}
          authorizationUrl={view.authorizationUrl}
          expiresAtMs={view.expiresAtMs}
          signIn={signIn}
        />
      );
      break;
    case 'finishing':
      body = (
        <Resting
          testID={`${testID}:finishing`}
          leading={<ActivitySpinner size="small" />}
          title={t('capabilities.mcpSignIn.finishingTitle', {
            machine: view.machineName,
          })}
          body={t('capabilities.mcpSignIn.finishingBody', {
            name,
            machine: view.machineName,
          })}
        />
      );
      break;
    case 'connected':
      body = (
        <Resting
          testID={`${testID}:connected`}
          leading={
            <Icon
              name="check-circle"
              size={16}
              color={theme.colors.state.success.foreground}
            />
          }
          title={
            view.identity
              ? t('capabilities.mcpSignIn.connectedAs', {
                  identity: view.identity,
                })
              : t('capabilities.mcpSignIn.connected')
          }
          body={
            view.lastUsedAt
              ? t('capabilities.mcpSignIn.connectedSince', {
                  date: formatDay(view.lastUsedAt),
                })
              : t('capabilities.mcpSignIn.connectedBody')
          }
          footer={
            view.scopes.length > 0 ? (
              <View style={styles.scopes}>
                {view.scopes.map((scope) => (
                  <Text key={scope} variant="meta" style={styles.scope}>
                    {scope}
                  </Text>
                ))}
              </View>
            ) : undefined
          }
          action={{
            label: t('capabilities.mcpSignIn.signOut'),
            display: 'inverted',
            loading: signIn.busy,
            disabled: signIn.busy,
            onPress: () => void signOut(),
          }}
        />
      );
      break;
    case 'needs_more_access':
      body = (
        <Resting
          testID={`${testID}:more-access`}
          chip={{ kind: 'more_access' }}
          body={t('capabilities.mcpSignIn.moreAccessBody', { name })}
          action={{
            label: t('capabilities.mcpSignIn.grantAccess'),
            display: 'default',
            onPress: () => void signIn.start({ stepUp: true }),
          }}
        />
      );
      break;
    case 'expired':
      body = (
        <Resting
          testID={`${testID}:expired`}
          chip={{ kind: 'expired' }}
          body={
            view.reason === 'address_changed'
              ? t('capabilities.mcpSignIn.addressChangedBody')
              : t('capabilities.mcpSignIn.expiredBody', { name })
          }
          action={{
            label: t('capabilities.mcpSignIn.reconnect'),
            display: 'default',
            onPress: () => void signIn.start(),
          }}
        />
      );
      break;
    case 'revoked':
      body = (
        <Resting
          testID={`${testID}:revoked`}
          chip={{ kind: 'revoked' }}
          body={t('capabilities.mcpSignIn.revokedBody', { name })}
          action={{
            label: t('capabilities.mcpSignIn.signInAgain'),
            display: 'default',
            onPress: () => void signIn.start(),
          }}
        />
      );
      break;
    case 'did_not_finish':
      body = (
        <Resting
          testID={`${testID}:did-not-finish`}
          title={t('capabilities.mcpSignIn.didNotFinishTitle', { name })}
          body={t('capabilities.mcpSignIn.didNotFinishBody')}
          action={{
            label: t('capabilities.mcpSignIn.tryAgain'),
            display: 'secondary',
            onPress: () => void signIn.start(),
          }}
        />
      );
      break;
    case 'no_machine_online':
      body = (
        <Resting
          testID={`${testID}:no-machine`}
          title={t('capabilities.mcpSignIn.noMachineTitle')}
          body={t('capabilities.mcpSignIn.noMachineBody')}
          action={{
            label: t('capabilities.mcpSignIn.signIn'),
            display: 'default',
            disabled: true,
            onPress: () => void signIn.start(),
          }}
        />
      );
      break;
    case 'client_refused':
    case 'invalid_client':
      body = (
        <Resting
          testID={`${testID}:client-refused`}
          title={view.state === 'invalid_client' ? t('capabilities.mcpSignIn.invalidClientTitle') : t('capabilities.mcpSignIn.clientRefusedTitle', { name })}
          body={t(view.state === 'invalid_client' ? 'capabilities.mcpSignIn.invalidClientBody' : 'capabilities.mcpSignIn.clientRefusedBody')}
          footer={<View style={styles.links}>
            <Link testID={`${testID}:own-app`} label={t(view.state === 'invalid_client' ? 'capabilities.mcpSignIn.editOwnApp' : 'capabilities.mcpSignIn.useOwnApp')}
              onPress={() => setEditingApp(true)} />
            {props.onUseApiKey ? <Link testID={`${testID}:client-refused:action`} label={t('capabilities.mcpSignIn.useApiKey')} onPress={props.onUseApiKey} /> : null}
          </View>}
        />
      );
      break;
  }
  if (editingApp && view.state !== 'signing' && view.state !== 'finishing') {
    body = <SectionContentRow testID={`${testID}:own-app-form`}>
      <View style={styles.form}>
        <View style={styles.stack}>
          <Text variant="label" emphasis="semiBold" style={styles.title}>{t('capabilities.mcpSignIn.useOwnApp')}</Text>
          <Text variant="body" style={styles.body}>{t(view.state === 'invalid_client' ? 'capabilities.mcpSignIn.invalidClientBody' : 'capabilities.mcpSignIn.ownAppBody')}</Text>
          {view.state === 'no_machine_online' ? <Text variant="body" style={styles.body}>{t('capabilities.mcpSignIn.noMachineBody')}</Text> : null}
        </View>
        <FieldItem label={t('capabilities.mcpSignIn.callbackUrl')}>
          <FieldTextInput testID={`${testID}:callback-url`} value={MCP_OAUTH_CALLBACK_URL_V1} onChangeText={() => {}} editable={false} monospace
            accessibilityLabel={t('capabilities.mcpSignIn.callbackUrl')}
            trailing={<IconButton testID={`${testID}:copy-callback`} iconName={callbackCopied ? 'check' : 'copy'} variant="plain" size={20}
              accessibilityLabel={t(callbackCopied ? 'common.copied' : 'common.copy')}
              onPress={() => void writeClipboard(MCP_OAUTH_CALLBACK_URL_V1).then(setCallbackCopied)} />} />
        </FieldItem>
        <FieldItem label={t('capabilities.mcpSignIn.clientId')} labelNativeID={`${testID}:client-id-label`}>
          <FieldTextInput testID={`${testID}:client-id`} value={clientId} onChangeText={setClientId} monospace
            accessibilityLabel={t('capabilities.mcpSignIn.clientId')} accessibilityLabelledBy={`${testID}:client-id-label`} editable={!signIn.busy} />
        </FieldItem>
        <FieldItem label={t('capabilities.mcpSignIn.clientSecret')} labelNativeID={`${testID}:client-secret-label`}>
          <FieldTextInput testID={`${testID}:client-secret`} value={clientSecret} onChangeText={setClientSecret} secureTextEntry
            accessibilityLabel={t('capabilities.mcpSignIn.clientSecret')} accessibilityLabelledBy={`${testID}:client-secret-label`} editable={!signIn.busy} />
        </FieldItem>
        <View style={styles.formActions}>
          {view.state === 'connected' || view.state === 'expired' || view.state === 'invalid_client' ?
            <Link testID={`${testID}:remove-own-app`} label={t('capabilities.mcpSignIn.removeOwnApp')} disabled={signIn.busy}
              onPress={() => { setEditingApp(false); setClientSecret(''); void signIn.start({ client: null }); }} /> : null}
          <View style={styles.formActionsEnd}>
            <Link testID={`${testID}:own-app-cancel`} label={t('common.cancel')} disabled={signIn.busy} onPress={() => { setEditingApp(false); setClientSecret(''); }} />
            <RoundButton testID={`${testID}:own-app-sign-in`} size="small" title={t('capabilities.mcpSignIn.signIn')}
              loading={signIn.busy} disabled={signIn.busy || !clientId.trim() || view.state === 'no_machine_online'}
              onPress={() => void signIn.start({ client: { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) } })} />
          </View>
        </View>
      </View>
    </SectionContentRow>;
  }
  return (
    <ItemGroup testID={testID} title={t('capabilities.mcpSignIn.title')}>
      {body}
      {view.state === 'signing' && view.clientRegistration === 'not_needed' ? <SectionContentRow>
        <Text variant="body" style={styles.body}>{t('capabilities.mcpSignIn.ownAppNotNeeded')}</Text>
      </SectionContentRow> : null}
      {!editingApp && (view.state === 'connected' || view.state === 'expired' || view.state === 'did_not_finish') ? <SectionContentRow>
        <Link testID={`${testID}:edit-own-app`} label={t('capabilities.mcpSignIn.editOwnApp')} onPress={() => setEditingApp(true)} />
      </SectionContentRow> : null}
    </ItemGroup>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  resting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s16,
    minWidth: 0,
  },
  restingText: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s4,
    alignItems: 'flex-start',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  title: { color: theme.colors.text.primary, flexShrink: 1 },
  body: { color: theme.colors.text.secondary },
  meta: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
  stack: { gap: theme.space.s6, minWidth: 0, flex: 1 },
  /** The own-app form: the statement, then each field on the sheet's rhythm, then its actions at the end (lab ms B "API key"). */
  form: { gap: theme.space.s16, minWidth: 0, flex: 1 },
  formActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s16 },
  formActionsEnd: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s16, marginLeft: 'auto' },
  waitingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s6,
  },
  waiting: { flex: 1, color: theme.colors.text.secondary },
  elsewhere: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  elsewhereText: { flex: 1, color: theme.colors.text.secondary },
  inlineLink: { color: theme.colors.text.primary },
  link: { color: theme.colors.text.primary },
  quietLinkBox: { marginTop: theme.space.s8, alignSelf: 'flex-start' },
  quietLink: { color: theme.colors.text.secondary },
  linkHover: { textDecorationLine: 'underline' },
  links: {
    flexDirection: 'row',
    gap: theme.space.s16,
    marginTop: theme.space.s6,
  },
  phone: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s16,
    alignItems: 'flex-start',
  },
  qr: { borderRadius: theme.borderRadius.md, overflow: 'hidden' },
  scopes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s6,
    marginTop: theme.space.s4,
  },
  scope: {
    ...Typography.mono(),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s6,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface.inset,
  },
}));
