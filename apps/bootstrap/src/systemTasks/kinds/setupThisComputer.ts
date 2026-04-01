import { systemTasks } from '@happier-dev/cli-common';
import {
  createAsyncGeneratorFromEventProducer,
  createLocalHappierJsonExecutor,
  createSetupMachineRecipeExecutorFromHappierJsonExecutor,
  runSetupMachineRecipe,
  type SetupMachineRecipeResult,
} from '@happier-dev/cli-common/systemTasks';

export interface SetupThisComputerParams {
  surface?: string;
  target?: string;
  installService?: boolean;
  startService?: boolean;
  verifyService?: boolean;
}

export function createSetupThisComputerHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<
    Readonly<{
      type: 'progress' | 'prompt';
      stepId: string;
      message?: string;
      data?: Record<string, string | boolean>;
    }>,
    Readonly<{ machineId: string }>,
    void
  > {
    const parsed = parseSetupThisComputerParams(params);

    const executor = createLocalHappierJsonExecutor();
    yield { type: 'progress', stepId: 'setup.thisComputer.resolveRelay' };
    const relay = await readActiveRelayProfile(executor);

    yield { type: 'progress', stepId: 'setup.thisComputer.checkAuth' };
    const recipeExecutor = createSetupMachineRecipeExecutorFromHappierJsonExecutor({ executor });
    const authStatus = await recipeExecutor.readAuthStatus();

    const recipeResult = yield* runSetupMachineRecipeAsEvents({
      relayProfile: relay,
      executor: recipeExecutor,
      initialAuthStatus: authStatus,
      steps: {
        installService: parsed.installService,
        startService: parsed.startService,
        verifyService: parsed.verifyService,
      },
      stepIds: {
        configureRelay: 'setup.thisComputer.configureRelay',
        authWait: 'setup.thisComputer.auth.wait',
        installService: 'setup.thisComputer.installService',
        startService: 'setup.thisComputer.startService',
        verifyService: 'setup.thisComputer.verifyService',
      },
      signal: context.signal,
      daemonReadinessErrorMessage: 'Daemon service did not reach a ready state for the selected Relay.',
    });

    const machineId = recipeResult.machineId;
    if (!machineId) {
      throw new systemTasks.SystemTaskExecutionError(
        'machine_id_unavailable',
        'Authenticated Relay session did not expose a machineId for this computer.',
      );
    }

    return { machineId };
  };
}

type SetupThisComputerEvent = Readonly<{
  type: 'progress' | 'prompt';
  stepId: string;
  message?: string;
  data?: Record<string, string | boolean>;
}>;

async function* runSetupMachineRecipeAsEvents(params: Readonly<{
  relayProfile: Parameters<typeof runSetupMachineRecipe>[0]['relayProfile'];
  executor: Parameters<typeof runSetupMachineRecipe>[0]['executor'];
  initialAuthStatus: Parameters<typeof runSetupMachineRecipe>[0]['initialAuthStatus'];
  steps: Parameters<typeof runSetupMachineRecipe>[0]['steps'];
  stepIds: Parameters<typeof runSetupMachineRecipe>[0]['stepIds'];
  signal: AbortSignal;
  daemonReadinessErrorMessage: string;
}>): AsyncGenerator<SetupThisComputerEvent, SetupMachineRecipeResult, void> {
  return yield* createAsyncGeneratorFromEventProducer((emit) => runSetupMachineRecipe({
    relayProfile: params.relayProfile,
    executor: params.executor,
    initialAuthStatus: params.initialAuthStatus,
    steps: params.steps,
    stepIds: params.stepIds,
    signal: params.signal,
    emit(event) {
      emit({
        type: 'progress',
        stepId: event.stepId,
        ...(event.message ? { message: event.message } : {}),
      });
    },
    approvePairingRequest: async (inner) => {
      emit({
        type: 'prompt',
        stepId: 'setup.thisComputer.auth.request',
        message: 'Approve this computer in Happier to continue',
        data: {
          kind: 'authRequest',
          publicKey: inner.publicKey,
          relayUrl: params.relayProfile.serverUrl,
          webappUrl: params.relayProfile.webappUrl,
        },
      });
    },
    daemonReadinessErrorMessage: params.daemonReadinessErrorMessage,
  }));
}

export function parseSetupThisComputerParams(params: unknown): SetupThisComputerParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Expected setup params to be an object.');
  }
  const record = params as Record<string, unknown>;
  const parsed: SetupThisComputerParams = {
    surface: typeof record.surface === 'string' ? record.surface : undefined,
    target: typeof record.target === 'string' ? record.target : undefined,
  };
  if ('installService' in record) {
    if (typeof record.installService !== 'boolean') {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Expected installService to be a boolean.');
    }
    parsed.installService = record.installService;
  }
  if ('startService' in record) {
    if (typeof record.startService !== 'boolean') {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Expected startService to be a boolean.');
    }
    parsed.startService = record.startService;
  }
  if ('verifyService' in record) {
    if (typeof record.verifyService !== 'boolean') {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Expected verifyService to be a boolean.');
    }
    parsed.verifyService = record.verifyService;
  }
  return parsed;
}

async function readActiveRelayProfile(executor: ReturnType<typeof createLocalHappierJsonExecutor>): Promise<Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>> {
  const parsed = await executor.runHappierJson(['server', 'current', '--json']);
  const active = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { active?: Record<string, unknown> } }).data?.active
    : null;

  const serverUrl = typeof active?.serverUrl === 'string' ? active.serverUrl.trim() : '';
  const webappUrl = typeof active?.webappUrl === 'string' && active.webappUrl.trim()
    ? active.webappUrl.trim()
    : serverUrl;
  const localServerUrl = typeof active?.localServerUrl === 'string' && active.localServerUrl.trim()
    ? active.localServerUrl.trim()
    : null;

  if (!serverUrl || !webappUrl) {
    throw new systemTasks.SystemTaskExecutionError(
      'relay_configuration_unavailable',
      'Could not resolve the currently selected Relay configuration.',
    );
  }

  return { serverUrl, webappUrl, localServerUrl };
}
