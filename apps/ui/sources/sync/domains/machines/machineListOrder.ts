/** Shared Machine list order: online first, then the name the person sees. Identity breaks ties at the caller. */
export function compareMachineListOrder(leftOnline: boolean, leftName: string, rightOnline: boolean, rightName: string): number {
    return Number(rightOnline) - Number(leftOnline) || leftName.localeCompare(rightName);
}
