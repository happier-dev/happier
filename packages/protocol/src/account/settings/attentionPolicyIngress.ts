import { isRecord } from '../../common/records.js';
import { AttentionDeliveryPolicyV1Schema, type AttentionDeliveryPolicyV1 } from './attentionDeliveryPolicy.js';
import { deriveAttentionDeliveryPolicyFromLegacySettings } from './attentionDeliveryPolicyLegacy.js';
import { NotificationsSettingsV1Schema } from './legacyNotifications.js';

/** The shared canonical/legacy policy ingress; unrelated Settings are never parsed. */
export function readAccountAttentionDeliveryPolicy(settings: unknown): AttentionDeliveryPolicyV1 {
  const source = isRecord(settings) ? settings : {};
  const supplied = source.attentionDeliveryPolicyV1;
  const parsed = supplied === undefined ? null : AttentionDeliveryPolicyV1Schema.safeParse(supplied);
  if (parsed?.success === true) {
    if (!Object.prototype.hasOwnProperty.call(parsed.data, 'mutePhoneWhenComputerFocused')
      && !Object.prototype.hasOwnProperty.call(supplied, 'mutePhoneWhenComputerFocused')) {
      const predecessor = NotificationsSettingsV1Schema.safeParse(source.notificationsSettingsV1);
      if (predecessor.success && predecessor.data.mutePhoneWhenComputerFocused === true) {
        return { ...parsed.data, mutePhoneWhenComputerFocused: true };
      }
    }
    return parsed.data;
  }
  return deriveAttentionDeliveryPolicyFromLegacySettings({
    notificationsSettings: NotificationsSettingsV1Schema.parse(source.notificationsSettingsV1),
  });
}
