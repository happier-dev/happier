import type { PluginJsonValueV2 } from '../plugins/contributions/publicTypes.js';
import type {
  AutomationEventPayloadV1,
  AutomationEventReplyContextV1,
} from './automationEventJsonBoundsV1.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

// Event payload and reply-context values are bounded at this Protocol owner,
// then consumed by the established Plugin JSON schema boundaries.
type _AutomationEventPayloadUsesPluginJsonProjection = Assert<
  IsAssignable<AutomationEventPayloadV1, PluginJsonValueV2>
>;

type _AutomationEventReplyContextUsesPluginJsonProjection = Assert<
  IsAssignable<AutomationEventReplyContextV1, PluginJsonValueV2>
>;
