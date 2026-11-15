import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PairingQrCode } from '@/components/auth/pairing/PairingQrCode';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import {
  HAPPIER_APP_LINK_ORIGIN,
  HAPPIER_APP_STORE_URL,
  HAPPIER_DESKTOP_DOWNLOAD_URL,
  HAPPIER_GOOGLE_PLAY_URL,
} from '@/constants/downloadUrls';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { isPhoneHardware } from '@/utils/platform/isPhoneHardware';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

/** The code's paper at the size a phone camera reads from across a desk. */
const QR_PAPER_PX = 168;
const MODAL_WIDTH_PX = 440;
/** Create one on Add a machine: the same page, opened in the app by its universal link. */
const ADD_CREATE_PATH = '/settings/machines/add?path=create';
const ADD_CREATE_APP_LINK = `${HAPPIER_APP_LINK_ORIGIN}${ADD_CREATE_PATH}`;

export function ManagedGetTheAppContent(
  props: CustomModalInjectedProps & Readonly<{ provider?: string }>,
) {
  // A phone's browser can't scan its own screen: it opens this page in the installed app by the same
  // universal link the code carries, and offers the stores for a phone without the app yet.
  const phone = isPhoneHardware();
  return (
    <View style={styles.body} testID="managed-get-the-app">
      <Text variant="body" style={styles.lead}>
        {props.provider ? t('managedMachines.add.handoff.body', { provider: props.provider })
          : t('managedMachines.add.handoff.cloudBody')}
      </Text>
      {phone ? (
        <>
          <RoundButton
            testID="managed-get-the-app.open"
            title={t('managedMachines.add.handoff.openInApp')}
            onPress={() => {
              void requestOpenExternalUrl(ADD_CREATE_APP_LINK);
            }}
          />
          <View style={styles.code}>
            <Text variant="meta" style={styles.caption}>
              {t('managedMachines.add.handoff.noAppYet')}
            </Text>
            <View style={styles.stores}>
              <RoundButton
                testID="managed-get-the-app.app-store"
                size="small"
                display="secondary"
                title={t('homeSetup.appStore')}
                onPress={() => {
                  void requestOpenExternalUrl(HAPPIER_APP_STORE_URL);
                }}
              />
              <RoundButton
                testID="managed-get-the-app.google-play"
                size="small"
                display="secondary"
                title={t('homeSetup.googlePlay')}
                onPress={() => {
                  void requestOpenExternalUrl(HAPPIER_GOOGLE_PLAY_URL);
                }}
              />
            </View>
          </View>
        </>
      ) : (
        <>
          <View style={styles.code}>
            <PairingQrCode
              testID="managed-get-the-app.qr"
              link={ADD_CREATE_APP_LINK}
              size={QR_PAPER_PX}
            />
            <Text variant="meta" style={styles.caption}>
              {t('managedMachines.add.handoff.scan')}
            </Text>
          </View>
          <RoundButton
            testID="managed-get-the-app.desktop"
            size="small"
            display="secondary"
            title={t('setupOnboarding.webDesktopOnlyDesktopAppButton')}
            onPress={() => {
              void requestOpenExternalUrl(HAPPIER_DESKTOP_DOWNLOAD_URL);
            }}
          />
        </>
      )}
    </View>
  );
}

/**
 * Web's hand-off for a provider the browser cannot reach (58d AF8): navigation only. On a computer a code
 * opens this page in the phone app and the desktop download sits beside it; on a phone the same link opens
 * it in the app, with the stores beneath. No request runs and nothing is created.
 */
export function showManagedGetTheAppModal(provider?: string): void {
  Modal.show({
    component: ManagedGetTheAppContent,
    props: { provider },
    chrome: {
      kind: 'card',
      title: t('managedMachines.add.handoff.title'),
      dimensions: { width: MODAL_WIDTH_PX },
      phonePresentation: 'sheet',
    },
  });
}

const styles = StyleSheet.create((theme) => ({
  // The card frame leaves the body edge to its content: the body stands on the header's inset.
  body: {
    gap: theme.space.s20,
    alignItems: 'center',
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
  lead: {
    alignSelf: 'stretch',
    color: theme.colors.text.secondary,
  },
  code: {
    alignItems: 'center',
    gap: theme.space.s10,
  },
  caption: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
  },
  stores: {
    flexDirection: 'row',
    gap: theme.space.s10,
  },
}));
