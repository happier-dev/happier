import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import {
  SimulatorPreviewActionResultV1Schema,
  SimulatorPreviewActionV1Schema,
  SimulatorPreviewSnapshotV1Schema,
} from '../../devices/simulator/runtimeV1.js';
import { refineKindSchema, type RuntimeActionSpecFamily } from './common.js';

const RuntimeSimulatorQualityScalarInputSchema = z
  .object({
    simulatorId: z.string().trim().min(1).max(256),
    streamId: z.string().trim().min(1).max(256),
    sourceId: z.string().trim().min(1).max(256),
    value: z.number().positive(),
  })
  .passthrough();

const RuntimeSimulatorGenericInputSchema = z
  .object({
    machineId: z.string().trim().min(1).max(256).optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: z.string().trim().min(1).max(256).optional(),
  })
  .passthrough();

export const SIMULATOR_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'devices.simulator.list': 'List simulator devices',
  'devices.simulator.stream.keyframe': 'Request simulator stream keyframe',
  'devices.simulator.stream.snapshot': 'Request simulator stream snapshot',
  'devices.simulator.stream.quality.set': 'Set simulator stream quality',
  'devices.simulator.stream.fps.set': 'Set simulator stream frame rate',
  'devices.simulator.stream.scale.set': 'Set simulator stream scale',
  'devices.simulator.lease.acquire': 'Acquire simulator control lease',
  'devices.simulator.lease.renew': 'Renew simulator control lease',
  'devices.simulator.lease.release': 'Release simulator control lease',
  'devices.simulator.input.tap': 'Tap simulator',
  'devices.simulator.input.swipe': 'Swipe simulator',
  'devices.simulator.input.text': 'Type simulator text',
  'devices.simulator.input.key': 'Press simulator key',
  'devices.simulator.input.button': 'Press simulator hardware button',
  'devices.simulator.input.orientation': 'Set simulator orientation',
  'devices.simulator.input.pinch': 'Pinch simulator',
  'devices.simulator.input.rotate': 'Rotate simulator',
  'devices.simulator.sideband.request': 'Request simulator sideband data',
});

const SIMULATOR_EVENT_TYPES_BY_RUNTIME_ACTION: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'devices.simulator.list': 'simulator.devices.list',
  'devices.simulator.stream.keyframe': 'simulator.keyframe.request',
  'devices.simulator.stream.snapshot': 'simulator.snapshot.request',
  'devices.simulator.stream.quality.set': 'simulator.quality.set',
  'devices.simulator.lease.acquire': 'simulator.lease.acquire',
  'devices.simulator.lease.renew': 'simulator.lease.renew',
  'devices.simulator.lease.release': 'simulator.lease.release',
  'devices.simulator.sideband.request': 'simulator.sideband.request',
});

const SIMULATOR_CONTROL_KINDS_BY_RUNTIME_ACTION: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'devices.simulator.input.tap': 'tap',
  'devices.simulator.input.swipe': 'swipe',
  'devices.simulator.input.text': 'keyboard_text',
  'devices.simulator.input.key': 'keyboard_key',
  'devices.simulator.input.button': 'hardware_button',
  'devices.simulator.input.orientation': 'orientation',
  'devices.simulator.input.pinch': 'pinch',
  'devices.simulator.input.rotate': 'rotate',
});

function refineSimulatorEventSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny {
  const expectedType = SIMULATOR_EVENT_TYPES_BY_RUNTIME_ACTION[actionId];
  if (expectedType) {
    return refineKindSchema(SimulatorPreviewActionV1Schema, 'type', expectedType, 'Simulator action type');
  }
  const expectedControl = SIMULATOR_CONTROL_KINDS_BY_RUNTIME_ACTION[actionId];
  if (!expectedControl) return RuntimeSimulatorGenericInputSchema;
  return SimulatorPreviewActionV1Schema.refine((value) => (
    value.type === 'simulator.control.send' && value.control.kind === expectedControl
  ), {
    message: `Simulator control action must send ${expectedControl}.`,
    path: ['control', 'kind'],
  });
}

function simulatorRuntimeActionInputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  if (actionId === 'devices.simulator.stream.fps.set' || actionId === 'devices.simulator.stream.scale.set') {
    return RuntimeSimulatorQualityScalarInputSchema;
  }
  if (actionId.startsWith('devices.simulator.')) return refineSimulatorEventSchema(actionId);
  return null;
}

function simulatorRuntimeActionOutputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  if (actionId === 'devices.simulator.list') return SimulatorPreviewSnapshotV1Schema;
  if (actionId.startsWith('devices.simulator.')) return SimulatorPreviewActionResultV1Schema;
  return null;
}

export const SIMULATOR_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: SIMULATOR_RUNTIME_ACTION_TITLES,
  inputSchemaForAction: simulatorRuntimeActionInputSchema,
  outputSchemaForAction: simulatorRuntimeActionOutputSchema,
} satisfies RuntimeActionSpecFamily);
