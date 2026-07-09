import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { createBuiltinVoiceAdapters } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';

import { createVoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import { setVoiceSessionLifecycleController } from './voiceSessionLifecycleControllerStore';
import { registerVoiceAdapters } from './voiceAdapterRegistry';
import { setVoiceSessionSnapshot } from './voiceSessionStore';

export function VoiceSessionRuntime(): React.ReactElement | null {
  const voice = useSetting('voice') as any;
  const providerId = resolveVoiceProviderId(voice?.providerId);
  const controllerRef = React.useRef<ReturnType<typeof createVoiceSessionLifecycleController> | null>(null);

  // Ensure adapters are registered before the user can interact with voice controls.
  React.useLayoutEffect(() => {
    registerVoiceAdapters(createBuiltinVoiceAdapters());
    const controller = createVoiceSessionLifecycleController();
    controllerRef.current = controller;
    const syncPublishedSnapshot = () => {
      setVoiceSessionSnapshot(controller.getSnapshot());
    };
    const unsubscribe = controller.subscribe(syncPublishedSnapshot);
    setVoiceSessionLifecycleController(controller);
    controller.setConfiguredProviderId(providerId);
    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      unsubscribe();
      setVoiceSessionLifecycleController(null);
      controller.dispose();
      setVoiceSessionSnapshot({
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
    };
  }, []);

  React.useEffect(() => {
    controllerRef.current?.setConfiguredProviderId(providerId);
  }, [providerId]);

  return null;
}
