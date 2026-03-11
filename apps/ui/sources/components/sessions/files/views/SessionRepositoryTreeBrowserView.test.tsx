import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
  const actual = await import('@/dev/reactNativeStub');
  return {
    ...actual,
    Platform: {
      OS: 'ios',
      select: (spec: Record<string, unknown>) =>
        spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
    },
  };
});

vi.mock('@expo/vector-icons', () => ({
  Octicons: 'Octicons',
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
  ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('react-native-unistyles', () => ({
  __esModule: true,
  useUnistyles: () => ({
    theme: {
      dark: false,
      colors: {
        text: '#000',
        textSecondary: '#666',
        groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        divider: '#ddd',
        modal: { border: '#ddd' },
        shadow: { color: '#000', opacity: 0.2 },
      },
    },
  }),
  StyleSheet: {
    create: (styles: any) =>
      typeof styles === 'function'
        ? styles({
            colors: {
              text: '#000',
              textSecondary: '#666',
              groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
              surface: '#fff',
              surfaceHigh: '#f5f5f5',
              divider: '#ddd',
              modal: { border: '#ddd' },
              shadow: { color: '#000', opacity: 0.2 },
            },
          })
        : styles,
  },
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
  t: (k: string) => k,
}));

let latestWorkspaceTransferParams: any = null;
vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
  useWorkspaceFileTransfers: (params: any) => {
    latestWorkspaceTransferParams = params;
    return {
      uploadState: { status: 'idle' },
      downloadState: { status: 'idle' },
      startUploads: vi.fn(async () => ({ ok: true })),
      cancelUploads: vi.fn(),
      startDownload: vi.fn(async () => ({ ok: true })),
      cancelDownload: vi.fn(),
    };
  },
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
  RepositoryTreeList: 'RepositoryTreeList',
}));

const searchFilesSpy = vi.fn();
vi.mock('@/sync/domains/input/suggestionFile', () => ({
  searchFiles: (...args: any[]) => searchFilesSpy(...args),
  fileSearchCache: { clearCache: vi.fn() },
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
  SearchResultsList: (props: any) => {
    const first = props.searchResults?.[0];
    return React.createElement('View' as any, {
      testID: first ? `search-results:${first.fullPath}` : 'search-results:empty',
      onPress: () => props.onFilePress?.(first),
    });
  },
}));

let sessionActive = true;
let machineReachable = true;
let sessionPath: string | null = null;
let projectPath: string | null = '/repo';
let machineRpcTargetAvailable = true;
const invalidateFromUserSpy = vi.fn();
vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) },
  useSession: () => ({ active: sessionActive, metadata: { machineId: 'm1', host: 'mbp', path: sessionPath } }),
  useProjectForSession: () => ({ key: { machineId: 'm1', path: projectPath } }),
  useAllMachines: () => (
    machineReachable
      ? [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
      : [{ id: 'm1', active: false, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
  ),
  useMachine: () => ({ id: 'm1' }),
  useSessionRepositoryTreeExpandedPaths: () => [],
  useSessionProjectScmSnapshot: () => null,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionMachineReachability: () => ({
    machineReachable,
    machineOnline: machineReachable,
    machineRpcTargetAvailable,
  }),
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
  SourceControlSessionInactiveState: 'SourceControlSessionInactiveState',
}));

vi.mock('@/modal', () => ({
  Modal: { prompt: vi.fn(async () => null), alert: vi.fn() },
}));

vi.mock('@/sync/ops', () => ({
  sessionWriteFile: vi.fn(async () => ({ success: true })),
  sessionCreateDirectory: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/utils/path/isSafeWorkspaceRelativePath', () => ({
  isSafeWorkspaceRelativePath: () => true,
}));

vi.mock('@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal', () => ({
  computeExpandedPathsForReveal: ({ expandedPaths }: any) => expandedPaths,
}));

vi.mock('@/scm/scmStatusSync', () => ({
  scmStatusSync: { invalidateFromUser: (sessionId: string) => invalidateFromUserSpy(sessionId) },
}));

describe('SessionRepositoryTreeBrowserView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchFilesSpy.mockReset();
    latestWorkspaceTransferParams = null;
    sessionActive = true;
    machineReachable = true;
    machineRpcTargetAvailable = true;
    sessionPath = null;
    projectPath = '/repo';
    invalidateFromUserSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows RepositoryTreeList when query is empty', async () => {
    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
    const onOpenFile = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={onOpenFile} />);
    });

    expect(tree.root.findAllByType('RepositoryTreeList' as any).length).toBe(1);
  });

  it('can hide the internal search bar', async () => {
    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
    const onOpenFile = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={onOpenFile} showSearchBar={false} />
      );
    });

    expect(tree.root.findAllByType('TextInput' as any).length).toBe(0);
  });

  it('searches via searchFiles and calls onOpenFile from results', async () => {
    searchFilesSpy.mockResolvedValueOnce([
      { fileName: 'api.ts', filePath: 'src/', fullPath: 'src/api.ts', fileType: 'file' },
    ]);

    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
    const onOpenFile = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={onOpenFile} />);
    });

    const input = tree.root.findByType('TextInput' as any);
    await act(async () => {
      input.props.onChangeText('api');
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    await act(async () => {});

    const results = tree.root.findByProps({ testID: 'search-results:src/api.ts' });
    await act(async () => {
      results.props.onPress();
    });

    expect(searchFilesSpy).toHaveBeenCalled();
    expect(onOpenFile).toHaveBeenCalledWith('src/api.ts');
  });

  it('reruns file search after upload success when the query stays the same', async () => {
    searchFilesSpy
      .mockResolvedValueOnce([
        { fileName: 'before.txt', filePath: '', fullPath: 'before.txt', fileType: 'file' },
      ])
      .mockResolvedValueOnce([
        { fileName: 'after.txt', filePath: '', fullPath: 'after.txt', fileType: 'file' },
      ]);

    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    });

    const input = tree.root.findByType('TextInput' as any);
    await act(async () => {
      input.props.onChangeText('manual-qa-upload');
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await act(async () => {});

    expect(tree.root.findByProps({ testID: 'search-results:before.txt' })).toBeTruthy();
    expect(searchFilesSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await latestWorkspaceTransferParams.onAfterUploadSuccess();
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await act(async () => {});

    expect(searchFilesSpy).toHaveBeenCalledTimes(2);
    expect(tree.root.findByProps({ testID: 'search-results:after.txt' })).toBeTruthy();
  });

  it('renders repository tree when the session is inactive but machine is reachable', async () => {
    sessionActive = false;
    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    });

    expect(tree.root.findAllByType('SourceControlSessionInactiveState' as any).length).toBe(0);
    expect(tree.root.findAllByType('RepositoryTreeList' as any).length).toBe(1);
  });

  it('renders repository tree when session is inactive and machine is offline but target is resolvable', async () => {
    sessionActive = false;
    machineReachable = false;
    machineRpcTargetAvailable = true;
    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    });

    expect(tree.root.findAllByType('SourceControlSessionInactiveState' as any).length).toBe(0);
    expect(tree.root.findAllByType('RepositoryTreeList' as any).length).toBe(1);
  });

  it('still renders the repository tree when the session is inactive and no machine target is available', async () => {
    sessionActive = false;
    sessionPath = '';
    projectPath = '';
    machineRpcTargetAvailable = false;
    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    });

    expect(tree.root.findAllByType('SourceControlSessionInactiveState' as any).length).toBe(0);
    expect(tree.root.findAllByType('RepositoryTreeList' as any).length).toBe(1);
  });

  it('warms SCM badges when machine RPC target availability flips to available', async () => {
    machineRpcTargetAvailable = false;
    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    });

    expect(invalidateFromUserSpy).not.toHaveBeenCalled();

    machineRpcTargetAvailable = true;

    await act(async () => {
      tree.update(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    });

    expect(invalidateFromUserSpy).toHaveBeenCalledTimes(1);
    expect(invalidateFromUserSpy).toHaveBeenCalledWith('s1');
  });
});
