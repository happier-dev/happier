import { projectNativeJsonValueForTransport as canonicalProjectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProtocolJsonValue } from './protocolFacade.js';
import { isStrictPluginJsonValue as canonicalIsStrictPluginJsonValue } from '@happier-dev/protocol/plugins/contributions/strictJsonValue';

/** Tests external frames without coercion through Protocol's strict JSON owner. */
export const isStrictPluginJsonValue: (input: unknown) => boolean = canonicalIsStrictPluginJsonValue;

/** Projects native optional members at transport boundaries using Protocol's sole strict JSON owner. */
export const projectNativeJsonValueForTransport: (input: unknown) => ProtocolJsonValue = canonicalProjectNativeJsonValueForTransport;
