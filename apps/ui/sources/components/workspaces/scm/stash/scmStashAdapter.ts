import type {
    ScmStashDropResponse,
    ScmStashListResponse,
    ScmStashPopResponse,
    ScmStashShowResponse,
} from '@happier-dev/protocol';

export type ScmStashDetailsAdapter = Readonly<{
    list: () => Promise<ScmStashListResponse>;
    show: (stashRef: string) => Promise<ScmStashShowResponse>;
    pop: (stashRef: string) => Promise<ScmStashPopResponse>;
    drop: (stashRef: string) => Promise<ScmStashDropResponse>;
}>;
