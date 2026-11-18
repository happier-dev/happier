import { RegistryFetchRequestV1Schema,RegistryFetchResponseV1Schema,createRegistryHostV1,isReadyRegistryThemeItemV1 } from '@happier-dev/protocol/registries';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import type { RpcHandlerContext } from '../rpc/types';

export function registerMachineRegistriesRpcHandlers(params:Readonly<{rpcHandlerManager:Pick<RpcHandlerManager,'registerHandler'>;
  createHost?:(signal?:AbortSignal,context?:RpcHandlerContext)=>ReturnType<typeof createRegistryHostV1>}>):void {
  const createHost=params.createHost??((signal,context)=>createCliRegistryHostV1({signal,machineAdmission:context?.machineAdmission}));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_REGISTRIES_FETCH,async(raw:unknown,context)=>{
    const parsed=RegistryFetchRequestV1Schema.safeParse(raw);
    if(!parsed.success)return {op:'error' as const,status:{state:'invalid_source' as const}};
    const response=await createHost(context?.signal,context).fetchRequest(parsed.data);
    if(response.op==='read' && isReadyRegistryThemeItemV1(response.item))return response;
    return RegistryFetchResponseV1Schema.parse(response);
  });
}
