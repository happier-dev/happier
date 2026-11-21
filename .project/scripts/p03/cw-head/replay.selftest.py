import os, pathlib, signal, subprocess, tempfile, time, sys
ROOT = pathlib.Path(__file__).resolve().parent
CP = os.environ.get('P03_SELFTEST_CP', str(ROOT / 'commit-partial.sh'))
REAL_GIT = subprocess.check_output(['which', 'git'], text=True).strip()
def case(kind):
    admission_case = kind in ('cas-final-entry', 'cas-final-declarations', 'declaration-admission-refused', 'declaration-admission-stall', 'two-stale-verdicts', 'entry-admission-refused', 'cas-churn')
    declaration_case = kind in ('cas-final-declarations', 'declaration-admission-refused', 'declaration-admission-stall', 'two-stale-verdicts')
    d = pathlib.Path(tempfile.mkdtemp(prefix='p03-replay-test.'))
    scratch = d/'wrapper-scratch'; scratch.mkdir()
    cache = d/'shared-cache'; cache.mkdir()
    env = dict(os.environ, P03_COMMIT_KICK='true', TMPDIR=str(scratch), P03_GATE_CACHE=str(cache))
    def git(*args):
        return subprocess.check_output([REAL_GIT, *args], cwd=d, env=env, text=True).strip()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Replay test'); git('config', 'user.email', 'replay@test.invalid')
    initial = ''.join(f'line {i}\n' for i in range(30))
    for f in ('a.txt', 'b.txt', 'c.txt', 'package.json'): (d/f).write_text(initial)
    git('add', '--', *(['a.txt', 'b.txt', 'package.json'] if kind == 'newfile' else ['a.txt', 'b.txt', 'c.txt', 'package.json'])); git('commit', '-qm', 'root')
    if admission_case:
        graph = d/'apps/stack/scripts/perf/entry-graphs.mjs'
        graph.parent.mkdir(parents=True)
        graph.write_text("export const ENTRY_GRAPHS = [{id:'cli',entry:'apps/cli/src/main.mjs'}];")
        cli = d/'apps/cli'; (cli/'src').mkdir(parents=True)
        (cli/'package.json').write_text('{"name":"@fixture/cli"}')
        (cli/'src/main.mjs').write_text('export {};')
        if declaration_case:
            source = d/'packages/protocol/src'
            source.mkdir(parents=True)
            (source.parent/'package.json').write_text('{"name":"@fixture/protocol"}')
            (source/'index.ts').write_text('export const selected = 0;')
            git('add', 'packages')
        git('add', 'apps'); git('commit', '-qm', 'fixture graph')
    base = git('rev-parse', 'HEAD')
    (d/'a.txt').write_text(initial.replace('line 2\n', 'packet A\n'))
    (d/'c.txt').write_text(initial.replace('line 2\n', 'packet C\n'))
    pk = ['a.txt', 'c.txt']
    if kind == 'manifest':
        (d/'package.json').write_text(initial.replace('line 2\n', 'packet dep\n')); pk.append('package.json')
    if admission_case:
        (d/'apps/cli/src/main.mjs').write_text('export const selected = 1;')
        pk.append('apps/cli/src/main.mjs')
        if declaration_case:
            (d/'packages/protocol/src/index.ts').write_text('export const selected = 1;')
            pk.append('packages/protocol/src/index.ts')
    (d/'packet.patch').write_text(git('diff', '-U3', 'HEAD', '--', *pk)+'\n')
    (d/'msg').write_text('test: packet A\n')
    idx = str(d/'private-b'); envb = dict(env, GIT_INDEX_FILE=idx)
    subprocess.check_call([REAL_GIT, 'read-tree', base], cwd=d, env=envb)
    target = 'b.txt' if kind in ('disjoint','newfile','cheapmiss','cas-loss','cas-final-entry','cas-final-declarations','two-stale-verdicts','declaration-admission-refused', 'declaration-admission-stall','entry-admission-refused','cas-churn','cas-stale','cas-worker-down','requeue','retention','two-stale-verdicts') else 'package.json' if kind == 'manifest' else 'a.txt'
    content = initial.replace('line 20\n', 'packet B\n') if kind != 'conflict' else initial.replace('line 2\n', 'conflict B\n')
    blob = subprocess.check_output([REAL_GIT, 'hash-object', '-w', '--stdin'], input=content, cwd=d, text=True).strip()
    subprocess.check_call([REAL_GIT, 'update-index', '--cacheinfo', f'100644,{blob},{target}'], cwd=d, env=envb)
    tree = subprocess.check_output([REAL_GIT, 'write-tree'], cwd=d, env=envb, text=True).strip()
    b = git('commit-tree', tree, '-p', base, '-m', 'test: packet B')
    later = git('commit-tree', tree, '-p', b, '-m', 'test: another writer landed')
    last = git('commit-tree', tree, '-p', later, '-m', 'test: moved while final worker prepared')
    # Git process boundary: B wins exactly when A attempts its first CAS.
    bindir = d/'bin'; bindir.mkdir()
    shim = bindir/'git'
    shim.write_text(f'''#!/bin/bash
if [[ '{kind}' = cas-loss || '{kind}' = cas-final-entry || '{kind}' = cas-final-declarations || '{kind}' = declaration-admission-refused || '{kind}' = declaration-admission-stall || '{kind}' = entry-admission-refused || '{kind}' = cas-churn || '{kind}' = cas-stale || '{kind}' = cas-worker-down ]] && [ "$1" = update-ref ] && [ ! -e '{d}/moved' ]; then
 touch '{d}/moved'
 '{REAL_GIT}' update-ref refs/heads/main '{b}' '{base}' || exit 99
 # A must retain its gated snapshot, even when its working files change.
 echo 'later worktree edit' > '{d}/c.txt'
elif [[ '{kind}' = cas-final-entry || '{kind}' = cas-final-declarations || '{kind}' = declaration-admission-refused || '{kind}' = declaration-admission-stall || '{kind}' = entry-admission-refused || '{kind}' = cas-churn || '{kind}' = cas-stale || '{kind}' = cas-worker-down ]] && [ "$1" = update-ref ] && [ ! -e '{d}/moved-twice' ]; then
 touch '{d}/moved-twice'
 '{REAL_GIT}' update-ref refs/heads/main '{later}' '{b}' || exit 99
elif [[ '{kind}' = cas-final-entry || '{kind}' = cas-final-declarations ]] && [ "$1" = update-ref ] && [ -e '{d}/moved-twice' ]; then
 [ "${{TEST_ENTRY_LEASE:-}}" = held ] || {{ echo 'final CAS ran outside the entry lease'; exit 99; }}
 [ '{kind}' != cas-final-declarations ] || [ "${{TEST_DECLARATION_LEASE:-}}" = held ] || {{ echo 'final CAS ran outside the declaration lease'; exit 99; }}
fi
exec '{REAL_GIT}' "$@"
'''); shim.chmod(0o755)
    # A second writer can land while the replayed candidate's full gate runs.
    gate = d/'gate.sh'; gate.write_text(f'''#!/bin/bash
printf '%s\n' "$0" >> '{d}/gate-paths'
if [ -n "${{P03_COMMIT_TREE_WORK_DIR:-}}" ]; then
 mkdir -p "$P03_COMMIT_TREE_WORK_DIR/tree-test" || exit 99
 echo payload > "$P03_COMMIT_TREE_WORK_DIR/tree-test/input"
fi
if [ '{kind}' = retention ] || [ '{kind}' = requeue ]; then
 if [ -n "${{P03_TEST_HEAD_SEED:-}}" ]; then
   [ -f "$P03_GATE_CACHE/scan-v2-T$P03_TEST_HEAD_SEED.txt" ] || exit 99
   [ -f "$P03_GATE_CACHE/scanidx-v2-T$P03_TEST_HEAD_SEED.gz" ] || exit 99
 elif [ -e '{d}/prior-cache' ]; then
   prior=$(cat '{d}/prior-cache')
   [ -f "$P03_GATE_CACHE/scan-v2-T$prior.txt" ] || exit 99
 else
   git rev-parse "$2^{{tree}}" > '{d}/prior-cache'
 fi
 for rev in "$1" "$2"; do
   tree=$(git rev-parse "$rev^{{tree}}") || exit 99
   printf '%s\n' "$tree" > "$P03_GATE_CACHE/scan-v2-T$tree.txt"
   printf '%s\n' "$tree" > "$P03_GATE_CACHE/scanidx-v2-T$tree.gz"
 done
 echo private > "$P03_GATE_CACHE/packet-local-test"
fi
if [ '{kind}' = signal ]; then
 touch '{d}/ready'
 exec sleep 120
fi
l=unlocked; flock -n "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" true || l=locked
if [ '{kind}' = requeue ]; then echo "${{HAPPIER_COMMIT_GATE_ARRIVED_AT:-}}" >> '{d}/arrivals'; fi
if [[ '{kind}' != cas-loss && '{kind}' != cas-final-entry && '{kind}' != cas-final-declarations && '{kind}' != declaration-admission-refused && '{kind}' != declaration-admission-stall && '{kind}' != entry-admission-refused && '{kind}' != cas-churn && '{kind}' != cas-stale && '{kind}' != cas-worker-down && '{kind}' != incomplete ]] && [ ! -e '{d}/moved' ]; then
 touch '{d}/moved'
 flock -x "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" '{REAL_GIT}' update-ref refs/heads/main '{b}' '{base}' || exit 99
 echo 'later worktree edit' > '{d}/c.txt'
fi
[[ '{kind}' = cheapmiss || '{kind}' = requeue ]] && [ -n "${{P03_SCAN_CHEAP_ONLY:-}}" ] && [ ! -e '{d}/.missed' ] && {{ touch '{d}/.missed'; echo "$(git diff --name-only "$1" "$2" | sort | paste -sd,)|${{P03_GATE_PRIOR:+fast}}|$l|cheap-miss" >> '{d}/gates'; exit 3; }}
echo "$(git diff --name-only "$1" "$2" | sort | paste -sd,)|${{P03_GATE_PRIOR:+fast}}|$l" >> '{d}/gates'
if [ '{kind}' = two-stale-verdicts ]; then
 if [ -n "${{P03_SCAN_CHEAP_ONLY:-}}" ]; then
   [ "${{P03_GATE_FINAL_DECLARATION_RECHECK:-}}" = 1 ] || exit 3
   [ "$l" = locked ] && [ "${{TEST_ENTRY_LEASE:-}}" = held ] && [ "${{TEST_DECLARATION_LEASE:-}}" = held ] || exit 99
 elif [ "$1" = '{b}' ]; then
   flock -n "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" '{REAL_GIT}' update-ref refs/heads/main '{later}' '{b}' || exit 99
 fi
fi
if [ '{kind}' = requeue ] && [ -e '{d}/.missed' ] && [ -z "${{P03_SCAN_CHEAP_ONLY:-}}" ] && [ "$l" = unlocked ]; then
 flock -n "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" '{REAL_GIT}' update-ref refs/heads/main '{later}' '{b}' || exit 99
fi
[ '{kind}' != incomplete ] || exit 11
if [[ '{kind}' = cas-final-entry || '{kind}' = cas-final-declarations || '{kind}' = declaration-admission-refused || '{kind}' = declaration-admission-stall || '{kind}' = entry-admission-refused || '{kind}' = cas-churn || '{kind}' = cas-stale || '{kind}' = cas-worker-down ]] && [ -e '{d}/moved-twice' ]; then
 if [ -n "${{P03_SCAN_CHEAP_ONLY:-}}" ]; then
   if [ '{kind}' = cas-final-declarations ] && [ "${{P03_GATE_FINAL_DECLARATION_RECHECK:-}}" = 1 ]; then
     [ "$l" = locked ] && [ "${{TEST_ENTRY_LEASE:-}}" = held ] && [ "${{TEST_DECLARATION_LEASE:-}}" = held ] || exit 99
     exit 0
   fi
   if [ '{kind}' = cas-final-entry ] && [ "${{P03_GATE_FINAL_ENTRY_RECHECK:-}}" = 1 ]; then
     [ "$l" = locked ] && [ "${{TEST_ENTRY_LEASE:-}}" = held ] || {{ echo 'locked check reached the graph without pre-admission'; exit 99; }}
     exit 0
   fi
   exit 3
 fi
 [ "$l" = unlocked ] || {{ echo 'worker preparation is holding the commit lock'; exit 99; }}
 [ -z "${{TEST_ENTRY_LEASE:-}}" ] || {{ echo 'worker preparation is retaining the entry lease'; exit 99; }}
 if [ '{kind}' = cas-worker-down ]; then exit 75; fi
 if [ '{kind}' = cas-stale ]; then
   flock -n "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" '{REAL_GIT}' update-ref refs/heads/main '{last}' '{later}' || exit 99
 fi
fi
sleep 0.2
[ '{kind}' != refused ] || [ \"$(wc -l < '{d}/gates')\" -lt 2 ] || exit 10
''')
    fast = d/'fast.sh'; fast.write_text(f"#!/bin/bash\necho fast >> '{d}/fasts'\nsleep 0.2\nexit 2\n")
    env.update(PATH=str(bindir)+':'+env['PATH'], P03_COMMIT_GATE=str(gate), P03_COMMIT_FASTGATE=str(fast))
    if admission_case:
        launcher = d/'apps/stack/bin/hstack-exec'; launcher.parent.mkdir(parents=True)
        launcher.write_text(f'''#!/bin/bash
set -eu
flock -n "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" true
if [[ "$*" = *--class=gate-declaration-comparison* ]]; then
  [[ "$*" = *--projects=packages/protocol* && "$*" = *--no-wait* ]]
  [ -z "${{HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT:-}}" ]
  echo declaration-attempt >> '{d}/admission'
  [ '{kind}' != declaration-admission-refused ] || exit 96
  if [ '{kind}' = declaration-admission-stall ]; then
    printf '%s\n' 'HAPPIER_DECLARATION_COMPARISON_INCOMPLETE {{"cause":"no-cpu-progress","elapsedMs":301000,"cpuIdleMs":300000}}'
    exit 75
  fi
  export TEST_DECLARATION_LEASE=held HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT=declaration
else
  [[ "$*" = *--class=gate-entry-loads* && "$*" = *--projects=cli* ]]
  echo grant-attempt >> '{d}/admission'
  [ '{kind}' != entry-admission-refused ] || exit 96
  export TEST_ENTRY_LEASE=held HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT=entry
fi
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
'''); launcher.chmod(0o755)
    selected = '-'
    if kind == 'newfile':
        (d/'wholefiles').write_text('c.txt\n'); selected=str(d/'wholefiles')
    start=time.monotonic()
    command = ['bash', CP, str(d/'msg'), selected, str(d/'packet.patch')]
    if kind == 'signal':
        with subprocess.Popen(command, cwd=d, env=env, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, start_new_session=True) as child:
            try:
                until = time.monotonic() + 5
                while not (d/'ready').exists() and time.monotonic() < until and child.poll() is None:
                    time.sleep(0.01)
                assert (d/'ready').exists(), 'wrapper never started the gate'
            finally:
                os.killpg(child.pid, signal.SIGTERM)
            output, _ = child.communicate(timeout=5)
        print(f'{kind}: rc={child.returncode} scratch={list(scratch.iterdir())} evidence={d}', flush=True)
        assert child.returncode in (-signal.SIGTERM, 143), output
        assert git('rev-parse','HEAD') == base
        assert not list(scratch.iterdir()), 'aborted packet leaked its gate copy or tree'
        return
    run=subprocess.run(command, cwd=d, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert not list(scratch.iterdir()), f'packet leaked scratch: {list(scratch.iterdir())}'
    assert all(not pathlib.Path(path).exists() for path in (d/'gate-paths').read_text().splitlines())
    elapsed=time.monotonic()-start
    (d/'run.log').write_text(run.stdout)
    gates=(d/'gates').read_text().splitlines()
    print(f'{kind}: {elapsed:.3f}s rc={run.returncode} gates={gates} evidence={d}', flush=True)
    if admission_case:
        assert (d/'admission').exists(), 'no entry admission attempt occurred before taking the final lock'
        expected_grants = ['grant-attempt', 'declaration-attempt'] if declaration_case else ['grant-attempt']
        assert (d/'admission').read_text().splitlines() == expected_grants, run.stdout
    if kind in ('declaration-admission-refused', 'declaration-admission-stall'):
        assert run.returncode == 11 and git('rev-parse','HEAD') == later, run.stdout
        assert 'declaration-comparison-incomplete' in run.stdout, run.stdout
        if kind == 'declaration-admission-stall':
            assert '"cpuIdleMs":300000' in run.stdout, run.stdout
            assert 'admission-unavailable' not in run.stdout, run.stdout
        assert len(gates) == 2, gates
    elif kind == 'entry-admission-refused':
        assert run.returncode == 11 and git('rev-parse','HEAD') == later, run.stdout
        assert 'entry-load-admission-unavailable' in run.stdout, run.stdout
        assert gates == ['a.txt,apps/cli/src/main.mjs,c.txt||unlocked', 'a.txt,apps/cli/src/main.mjs,c.txt|fast|locked'], gates
    elif kind == 'incomplete':
        assert run.returncode == 11 and git('rev-parse','HEAD') == base, run.stdout
        assert len(gates) == 1 and 'candidate gate incomplete' in run.stdout, run.stdout
    elif kind in ('cas-stale', 'cas-worker-down'):
        assert run.returncode == 11 and git('rev-parse','HEAD') == (last if kind == 'cas-stale' else later), run.stdout
        assert '"code":"final-recheck-incomplete"' in run.stdout, run.stdout
        assert subprocess.run(['flock', '-n', str(d/'.git/p03-commit-partial.lock'), 'true']).returncode == 0
        expected = ['a.txt,c.txt||unlocked', 'a.txt,c.txt|fast|locked', 'a.txt,c.txt|fast|locked', 'a.txt,c.txt|fast|unlocked']
        if kind == 'cas-stale': expected.append('a.txt,c.txt|fast|locked')
        assert gates == expected, gates
    elif kind in ('conflict', 'refused'):
        assert run.returncode != 0 and git('rev-parse','HEAD') == b, run.stdout
        assert ('replay conflict' if kind == 'conflict' else 'candidate refused') in run.stdout.lower(), run.stdout
    else:
        assert run.returncode == 0, run.stdout
        assert git('rev-parse','HEAD^') == (later if kind in ('requeue', 'cas-final-entry', 'cas-final-declarations', 'cas-churn', 'two-stale-verdicts') else b)
        if kind in ('retention', 'requeue'):
            head_tree = git('rev-parse', 'HEAD^{tree}')
            payloads = sorted(p.name for p in cache.rglob('*') if p.is_file() and not p.name.endswith('.lock') and not p.name.endswith('.slot'))
            assert payloads == sorted([f'scan-v2-T{head_tree}.txt', f'scanidx-v2-T{head_tree}.gz']), payloads
        assert 'packet B' in git('show',f'HEAD:{target}'), 'replay lost B tree content'
        assert git('show','HEAD:a.txt').splitlines()[2] == 'packet A', 'replay lost A'
        if kind == 'intersect': assert git('show','HEAD:a.txt').splitlines()[20] == 'packet B', 'merged file lost B'
        if kind == 'manifest': assert git('show','HEAD:package.json').splitlines()[2] == 'packet dep', 'merged manifest lost A'
        assert git('show','HEAD:c.txt').splitlines()[2] == 'packet C', 'gated bytes changed'
        assert (d/'c.txt').read_text() == 'later worktree edit\n'
        pk = 'a.txt,c.txt' + (',package.json' if kind == 'manifest' else '')
        if admission_case: pk = 'a.txt,apps/cli/src/main.mjs,c.txt'
        if declaration_case: pk += ',packages/protocol/src/index.ts'
        cheap = pk + '|fast|locked'
        fallback = [cheap + '|cheap-miss', pk + '|fast|unlocked']
        full = {
            'manifest': [pk + '||unlocked'],
            'cheapmiss': fallback,
            'cas-loss': [cheap],
            'cas-final-entry': [cheap, cheap],
            'cas-final-declarations': [cheap, cheap],
            'two-stale-verdicts': [cheap, pk + '|fast|unlocked', cheap],
            'cas-churn': [cheap, cheap, pk + '|fast|unlocked'],
            'requeue': fallback + [cheap],
        }
        assert gates == [pk + '||unlocked'] + full.get(kind, [cheap]), gates
        if kind == 'requeue':
            arrivals = (d/'arrivals').read_text().splitlines()
            assert arrivals[0] == '' and arrivals[1].isdigit(), arrivals
            assert arrivals[1:] == [arrivals[1]] * (len(gates) - 1), arrivals
        assert not (d/'fasts').exists(), 'unnecessary fast gate'
        if kind in ('manifest', 'cheapmiss', 'requeue'):
            assert 'resumed the frozen packet' in run.stdout, run.stdout
        if kind in ('cas-loss', 'cas-final-entry', 'cas-churn'):
            if kind in ('cas-final-entry', 'cas-churn'):
                assert 'final scoped recheck under the commit lock' in run.stdout, run.stdout
            assert 'CAS lost to a commit outside the wrapper' in run.stdout, run.stdout
        assert git('reflog', '-1', '--format=%gs', 'refs/heads/main').startswith('commit-partial: pid '), 'reflog does not name the wrapper'
        if kind == 'retention':
            (d/'b.txt').write_text(git('show', 'HEAD:b.txt').replace('line 1\n', 'next packet\n')+'\n')
            (d/'packet.patch').write_text(git('diff', '-U3', 'HEAD', '--', 'b.txt')+'\n')
            dry = subprocess.run(command, cwd=d, env=dict(env, DRY='1', P03_TEST_HEAD_SEED=head_tree),
                                 text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            assert dry.returncode == 0 and 'DRY candidate' in dry.stdout, dry.stdout
            assert not list(cache.glob('packet.*')), 'dry packet retained its private files'
for kind in sys.argv[1:] or ['disjoint','intersect','conflict','refused','newfile','manifest','cheapmiss','cas-loss','cas-final-entry','cas-final-declarations','declaration-admission-refused', 'declaration-admission-stall','entry-admission-refused','cas-churn','cas-stale','cas-worker-down','incomplete','requeue','two-stale-verdicts','signal','retention']: case(kind)
