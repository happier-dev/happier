import type { BrowserContextLifecycleStateV1 } from './v1.js';
import sensitiveFieldsExpression from './sensitiveFieldsExpression.json' with { type: 'json' };

/** Source-owned presence-only probe shared by CDP and the native WebView capture producer. */
export const browserContextSensitiveFieldsExpression: string = sensitiveFieldsExpression;

export type BrowserContextPrivacyState = Extract<
  BrowserContextLifecycleStateV1,
  'sensitiveOrigin' | 'sensitiveFieldsPresent' | 'ephemeralOnly'
>;

export type BrowserContextPrivacyDenial = Readonly<{
  lifecycleState: BrowserContextPrivacyState;
  reasonCode:
    | 'browser_context_sensitive_origin'
    | 'browser_context_sensitive_fields_present'
    | 'browser_context_ephemeral_only';
}>;

/** The shared export floor. Sources establish privacy facts; consumers never override them. */
export function resolveBrowserContextPrivacyDenial(
  privacyState: BrowserContextPrivacyState | null | undefined,
): BrowserContextPrivacyDenial | null {
  switch (privacyState) {
    case 'sensitiveOrigin':
      return { lifecycleState: privacyState, reasonCode: 'browser_context_sensitive_origin' };
    case 'sensitiveFieldsPresent':
      return { lifecycleState: privacyState, reasonCode: 'browser_context_sensitive_fields_present' };
    case 'ephemeralOnly':
      return { lifecycleState: privacyState, reasonCode: 'browser_context_ephemeral_only' };
    case null:
    case undefined:
      return null;
  }
}
