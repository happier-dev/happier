
/** Action identity leaf: schema modules and the registry share these constants. */
export const WIDGET_INSTANCE_ACTION_IDS_V1 = [
  'widgets.catalog.list', 'widgets.item.list', 'widgets.item.add', 'widgets.item.remove',
  'widgets.item.move', 'widgets.item.rename', 'widgets.item.size.set', 'widgets.item.frame.set',
  'widgets.item.network.set',
  'widgets.item.inputs.get', 'widgets.item.inputs.validate', 'widgets.item.inputs.set',
  'widgets.item.inputs.reset', 'widgets.item.refresh',
  'widgets.group.create', 'widgets.group.add', 'widgets.group.ungroup', 'widgets.group.set', 'widgets.group.inputs.set',
  'widgets.area.layout.select',
  'widgets.area.layout.reset', 'widgets.area.layout.undo',
  'widgets.area.layout.list', 'widgets.area.layout.create', 'widgets.area.layout.rename',
  'widgets.area.layout.delete', 'widgets.area.layout.reorder',
] as const;
