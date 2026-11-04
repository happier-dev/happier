import { projectNativeJsonValueForTransport as canonicalProjectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProtocolJsonValue } from './protocolFacade.js';

/** Projects native optional members at transport boundaries using Protocol's sole strict JSON owner. */
export const projectNativeJsonValueForTransport: (input: unknown) => ProtocolJsonValue = canonicalProjectNativeJsonValueForTransport;
