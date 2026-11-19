
/** Action identity leaf: schema modules and the registry share these constants. */
export const WIDGET_CATALOG_LIST_ACTION_ID_V1 = 'widgets.catalog.list' as const;
export const WIDGET_REMOVE_ACTION_ID_V1 = 'widgets.item.remove' as const;
export const WIDGET_INPUTS_GET_ACTION_ID_V1 = 'widgets.item.inputs.get' as const;
export const WIDGET_INPUTS_RESET_ACTION_ID_V1 = 'widgets.item.inputs.reset' as const;
export const WIDGET_REFRESH_ACTION_ID_V1 = 'widgets.item.refresh' as const;
export const WIDGET_INSTANCE_ACTION_IDS_V1 = [
  WIDGET_CATALOG_LIST_ACTION_ID_V1, 'widgets.item.list', 'widgets.item.add', WIDGET_REMOVE_ACTION_ID_V1,
  'widgets.item.move', 'widgets.item.rename', 'widgets.item.size.set', 'widgets.item.frame.set',
  'widgets.item.network.set',
  WIDGET_INPUTS_GET_ACTION_ID_V1, 'widgets.item.inputs.validate', 'widgets.item.inputs.set',
  WIDGET_INPUTS_RESET_ACTION_ID_V1, WIDGET_REFRESH_ACTION_ID_V1,
  'widgets.group.create', 'widgets.group.add', 'widgets.group.ungroup', 'widgets.group.set', 'widgets.group.inputs.set',
  'widgets.area.layout.select',
  'widgets.area.layout.reset', 'widgets.area.layout.undo',
  'widgets.area.layout.list', 'widgets.area.layout.create', 'widgets.area.layout.rename',
  'widgets.area.layout.delete', 'widgets.area.layout.reorder',
] as const;
