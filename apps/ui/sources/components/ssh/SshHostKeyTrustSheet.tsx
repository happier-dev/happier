import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { Text } from '@/components/ui/text/Text';
import { useDeviceType } from '@/utils/platform/responsive';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

/** A server's SSH host key, as the connecting task reports it. */
export type SshHostKeyTrustRequest = Readonly<{
  host: string;
  keyType?: string | null;
  fingerprint: string;
  /** Set when the server's key changed since it was last trusted. */
  existingFingerprint?: string | null;
}>;

/** "ssh-ed25519" and "ED25519" both read as the key's family; ECDSA curves read as ECDSA. */
function formatSshKeyType(keyType: string | null | undefined): string | null {
  const raw = keyType?.trim().replace(/^ssh-/i, '') ?? '';
  if (!raw) return null;
  return (raw.toLowerCase().startsWith('ecdsa') ? 'ecdsa' : raw).toUpperCase();
}

function Fingerprint(
  props: Readonly<{ label: string; value: string; testID: string }>,
) {
  return (
    <View style={styles.fingerprint}>
      <Text variant="label" emphasis="medium" style={styles.label}>
        {props.label}
      </Text>
      {/* Compared by eye with the provider's console: every character visible, selectable, copyable. */}
      <CodeBlockView
        code={props.value}
        showHeaderRow={false}
        wrap
        selectable
        showCopyButton
        scrollTestID={props.testID}
      />
    </View>
  );
}

function SshHostKeyTrustContent(
  props: CustomModalInjectedProps &
    Readonly<{
      request: SshHostKeyTrustRequest;
      onResolve: (trusted: boolean) => void;
    }>,
) {
  const { request, onResolve, onClose } = props;
  const changed = Boolean(request.existingFingerprint?.trim());
  const phone = useDeviceType() === 'phone';
  const keyType = formatSshKeyType(request.keyType);
  const resolve = (trusted: boolean) => {
    onResolve(trusted);
    onClose();
  };
  return (
    <View testID="ssh-host-key" style={styles.body}>
      <Text variant="body" style={styles.paragraph}>
        {changed
          ? t('addFlows.hostKeyChangedBody')
          : t('addFlows.hostKeyBody', { host: request.host })}
      </Text>
      {changed ? (
        <>
          <Fingerprint
            testID="ssh-host-key.previous"
            label={t('settings.remoteHostsHostKeyCurrentFingerprintLabel')}
            value={request.existingFingerprint!.trim()}
          />
          <Fingerprint
            testID="ssh-host-key.new"
            label={t('settings.remoteHostsHostKeyNewFingerprintLabel')}
            value={request.fingerprint}
          />
        </>
      ) : (
        <Fingerprint
          testID="ssh-host-key.fingerprint"
          label={
            keyType
              ? t('addFlows.hostKeyFingerprint', { type: keyType })
              : t('addFlows.hostKeyFingerprintPlain')
          }
          value={request.fingerprint}
        />
      )}
      {/* A phone sheet stacks the one primary over a quiet Cancel, in thumb reach (lab af-ssh Kp). */}
      <View style={phone ? styles.footerStacked : styles.footer}>
        {phone ? null : (
          <RoundButton
            testID="ssh-host-key.cancel"
            size="normal"
            display="secondary"
            title={t('common.cancel')}
            onPress={() => resolve(false)}
          />
        )}
        <RoundButton
          testID="ssh-host-key.trust"
          size="normal"
          title={
            changed
              ? t('settings.remoteHostsReplaceHostKeyAction')
              : t('addFlows.hostKeyTrust')
          }
          onPress={() => resolve(true)}
        />
        {phone ? (
          <RoundButton
            testID="ssh-host-key.cancel"
            size="normal"
            display="inverted"
            title={t('common.cancel')}
            onPress={() => resolve(false)}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * Asks whether to trust a server's SSH host key (58d AF4, lab af-ssh Kp): a sheet on a phone, a dialog
 * elsewhere, with the fingerprint in full. Resolves `true` only for Trust; every way of backing out, and
 * a `signal` that aborts because the prompt went away, resolves `false` and closes it.
 */
export function confirmSshHostKey(
  request: SshHostKeyTrustRequest,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<boolean> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (trusted: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(trusted);
    };
    const changed = Boolean(request.existingFingerprint?.trim());
    const id = Modal.show({
      component: SshHostKeyTrustContent,
      props: { request, onResolve: settle },
      onRequestClose: () => settle(false),
      chrome: {
        kind: 'card',
        title: changed
          ? t('addFlows.hostKeyChangedTitle', { host: request.host })
          : t('addFlows.hostKeyTitle'),
        testID: 'ssh-host-key-modal',
        phonePresentation: 'sheet',
        dimensions: {
          width: HAPPIER_PAGE_METRICS.dialogWidthPx.default,
          maxHeightRatio: 0.86,
          size: 'md',
        },
      },
      // A stray tap must not decide a security question.
      closeOnBackdrop: false,
    });
    function abort() {
      Modal.hide(id);
      settle(false);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Presents a pending host-key prompt while it is the current one; `decide` receives the person's answer.
 * The sheet closes without answering when the prompt goes away (answered elsewhere, task ended, view left).
 */
export function useSshHostKeyTrustSheet(
  request: SshHostKeyTrustRequest | null,
  decide: (trusted: boolean) => void,
): void {
  const decideRef = React.useRef(decide);
  const requestRef = React.useRef(request);
  React.useLayoutEffect(() => {
    decideRef.current = decide;
    requestRef.current = request;
  });
  const key = request
    ? [
        request.host,
        request.keyType ?? '',
        request.fingerprint,
        request.existingFingerprint ?? '',
      ].join('\n')
    : null;
  React.useEffect(() => {
    const current = requestRef.current;
    if (!key || !current) return;
    const abort = new AbortController();
    void confirmSshHostKey(current, { signal: abort.signal }).then(
      (trusted) => {
        if (!abort.signal.aborted) decideRef.current(trusted);
      },
    );
    return () => abort.abort();
  }, [key]);
}

const styles = StyleSheet.create((theme) => ({
  // The card frame leaves the body edge to its content: the body stands on the header's inset.
  body: {
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
  paragraph: {
    color: theme.colors.text.secondary,
  },
  fingerprint: {
    gap: theme.space.s8,
  },
  label: {
    color: theme.colors.text.primary,
  },
  footerStacked: {
    alignItems: 'stretch',
    gap: theme.space.s8,
    marginTop: theme.space.s4,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    marginTop: theme.space.s4,
  },
}));
