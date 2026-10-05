import { expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { PluginActionInputById, PluginActionResultById } from './actionSpecs.js';
import type { SESSION_CANVAS_ACTION_INPUT_SCHEMAS, SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS } from './sessionCanvasActionFamily.js';
import type { WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../widgets/actionsV1.js';
import type { WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1 } from '../widgets/definitionActionsV1.js';

it('preserves per-ID Canvas and widget schema carriers in the public plugin Action types', () => {
  expectTypeOf<PluginActionInputById['session.canvas.tabs.open']>()
    .toEqualTypeOf<z.input<typeof SESSION_CANVAS_ACTION_INPUT_SCHEMAS['session.canvas.tabs.open']>>();
  expectTypeOf<PluginActionResultById['session.canvas.tabs.open']>()
    .toEqualTypeOf<z.output<typeof SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS['session.canvas.tabs.open']>>();
  expectTypeOf<PluginActionInputById['widgets.catalog.list']>()
    .toEqualTypeOf<z.input<typeof WidgetInstanceActionInputSchemasV1['widgets.catalog.list']>>();
  expectTypeOf<PluginActionResultById['widgets.catalog.list']>()
    .toEqualTypeOf<z.output<typeof WidgetInstanceActionOutputSchemasV1['widgets.catalog.list']>>();
  expectTypeOf<PluginActionInputById['widgets.definition.update']>()
    .toEqualTypeOf<z.input<typeof WidgetDefinitionActionInputSchemasV1['widgets.definition.update']>>();
  expectTypeOf<PluginActionResultById['widgets.definition.update']>()
    .toEqualTypeOf<z.output<typeof WidgetDefinitionActionOutputSchemasV1['widgets.definition.update']>>();
});
