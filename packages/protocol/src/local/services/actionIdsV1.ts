/** Schema-free ids: Action identity must not initialize its own spec graph. */
export const MACHINE_SERVICE_FRONTDOOR_ACTION_IDS = [
  'machines.services.list', 'machines.services.discovery', 'machines.services.detail',
  'machines.services.watch', 'machines.services.unwatch',
] as const;
export const MACHINE_SERVICE_ACTION_IDS = [...MACHINE_SERVICE_FRONTDOOR_ACTION_IDS, 'machines.services.logs.read', 'machines.services.control', 'machines.services.exec'] as const;
