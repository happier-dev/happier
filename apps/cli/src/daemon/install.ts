import { logger } from '@/ui/logger';
import { installDaemonService } from './service/installer';

export async function install(): Promise<void> {
  logger.info('Installing Happier CLI daemon service...');
  await installDaemonService();
  logger.info('Daemon service installed');
}
