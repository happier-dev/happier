import { logger } from '@/ui/logger';

type PushApi = {
  push: () => {
    sendToAllDevices: (title: string, body: string, data: { sessionId: string }) => void;
  };
};

function isTruthyEnv(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function createKiloReadyPushNotifier(params: {
  api: PushApi;
  sessionId: string;
}): { maybeSend: () => void } {
  let sent = false;

  return {
    maybeSend: () => {
      if (sent) return;
      if (!isTruthyEnv(process.env.HAPPIER_KILO_READY_PUSH)) return;
      sent = true;
      try {
        params.api.push().sendToAllDevices("It's ready!", 'Kilo is waiting for your command', { sessionId: params.sessionId });
      } catch (error) {
        logger.debug('[Kilo] Failed to send ready push', error);
      }
    },
  };
}

