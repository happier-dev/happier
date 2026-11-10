import type { SupportedLanguage } from '../_all';

type PreparationCopy = Readonly<{
  prepare: string; import: string; lead: string; importLead: string;
  workspace: string; tool: string; paths: string; noWorkspace: string; noRepository: string;
}>;

export const deploymentPreparationTranslations: Record<SupportedLanguage, PreparationCopy> = {
  en: {
    noRepository: "This Project needs a repository. Add one to its Source before preparing a deployment.",
    prepare: 'Prepare with an agent', import: 'Import from another tool',
    lead: 'An agent prepares the deployment in a Session and opens a pull request. Review its exact commit and validation before merging. Deploying is a separate step.',
    importLead: 'Choose the existing tool and configuration files, one path per line. The agent proposes an import in a pull request. Your existing deployment keeps running.',
    workspace: 'Where the agent works', tool: 'Existing tool', paths: 'Configuration file paths',
    noWorkspace: 'Open this Project on a Machine first, then choose its checkout here.',
  },
  ru: {
    noRepository: "Этому проекту нужен репозиторий. Добавьте его в источник проекта перед подготовкой развёртывания.",
    prepare: 'Подготовить с агентом', import: 'Импортировать из другого инструмента',
    lead: 'Агент подготовит развёртывание в сессии и откроет pull request. Перед слиянием проверьте точный коммит и результаты проверки. Развёртывание выполняется отдельно.',
    importLead: 'Выберите текущий инструмент и файлы конфигурации: один путь в строке. Агент предложит импорт в pull request. Текущее развёртывание продолжит работать.',
    workspace: 'Где работает агент', tool: 'Текущий инструмент', paths: 'Пути к файлам конфигурации',
    noWorkspace: 'Сначала откройте этот проект на машине, затем выберите здесь его рабочую копию.',
  },
  pl: {
    noRepository: "Ten projekt potrzebuje repozytorium. Dodaj je do źródła projektu przed przygotowaniem wdrożenia.",
    prepare: 'Przygotuj z agentem', import: 'Importuj z innego narzędzia',
    lead: 'Agent przygotuje wdrożenie w sesji i otworzy pull request. Przed scaleniem sprawdź dokładny commit i wyniki walidacji. Wdrożenie to osobny krok.',
    importLead: 'Wybierz obecne narzędzie i pliki konfiguracji, po jednej ścieżce w wierszu. Agent zaproponuje import w pull requeście. Obecne wdrożenie będzie nadal działać.',
    workspace: 'Gdzie pracuje agent', tool: 'Obecne narzędzie', paths: 'Ścieżki plików konfiguracji',
    noWorkspace: 'Najpierw otwórz ten projekt na maszynie, a potem wybierz tutaj jego kopię roboczą.',
  },
  es: {
    noRepository: "Este proyecto necesita un repositorio. Añádelo a su origen antes de preparar un despliegue.",
    prepare: 'Preparar con un agente', import: 'Importar de otra herramienta',
    lead: 'Un agente prepara el despliegue en una sesión y abre una pull request. Revisa el commit exacto y su validación antes de fusionar. Desplegar es un paso aparte.',
    importLead: 'Elige la herramienta actual y los archivos de configuración, una ruta por línea. El agente propone la importación en una pull request. Tu despliegue actual sigue funcionando.',
    workspace: 'Dónde trabaja el agente', tool: 'Herramienta actual', paths: 'Rutas de los archivos de configuración',
    noWorkspace: 'Primero abre este proyecto en una máquina y luego elige aquí su copia de trabajo.',
  },
  fr: {
    noRepository: "Ce projet nécessite un dépôt. Ajoutez-en un à sa source avant de préparer un déploiement.",
    prepare: 'Préparer avec un agent', import: 'Importer depuis un autre outil',
    lead: 'Un agent prépare le déploiement dans une session et ouvre une pull request. Vérifiez le commit exact et sa validation avant de fusionner. Le déploiement est une étape distincte.',
    importLead: 'Choisissez l’outil actuel et les fichiers de configuration, un chemin par ligne. L’agent propose l’import dans une pull request. Votre déploiement actuel continue de fonctionner.',
    workspace: 'Où travaille l’agent', tool: 'Outil actuel', paths: 'Chemins des fichiers de configuration',
    noWorkspace: 'Ouvrez d’abord ce projet sur une machine, puis choisissez sa copie de travail ici.',
  },
  it: {
    noRepository: "Questo progetto richiede un repository. Aggiungilo alla sua origine prima di preparare un deployment.",
    prepare: 'Prepara con un agente', import: 'Importa da un altro strumento',
    lead: 'Un agente prepara il deployment in una sessione e apre una pull request. Controlla il commit esatto e la sua validazione prima del merge. Il deployment è un passaggio separato.',
    importLead: 'Scegli lo strumento attuale e i file di configurazione, un percorso per riga. L’agente propone l’importazione in una pull request. Il deployment attuale continua a funzionare.',
    workspace: 'Dove lavora l’agente', tool: 'Strumento attuale', paths: 'Percorsi dei file di configurazione',
    noWorkspace: 'Prima apri questo progetto su una macchina, poi scegli qui la sua copia di lavoro.',
  },
  pt: {
    noRepository: "Este projeto precisa de um repositório. Adicione um à sua origem antes de preparar a implantação.",
    prepare: 'Preparar com um agente', import: 'Importar de outra ferramenta',
    lead: 'Um agente prepara a implantação em uma sessão e abre um pull request. Revise o commit exato e sua validação antes de mesclar. Implantar é uma etapa separada.',
    importLead: 'Escolha a ferramenta atual e os arquivos de configuração, um caminho por linha. O agente propõe a importação em um pull request. Sua implantação atual continua funcionando.',
    workspace: 'Onde o agente trabalha', tool: 'Ferramenta atual', paths: 'Caminhos dos arquivos de configuração',
    noWorkspace: 'Primeiro abra este projeto em uma máquina e depois escolha sua cópia de trabalho aqui.',
  },
  ca: {
    noRepository: "Aquest projecte necessita un repositori. Afegeix-ne un a la seva font abans de preparar un desplegament.",
    prepare: 'Prepara amb un agent', import: 'Importa d’una altra eina',
    lead: 'Un agent prepara el desplegament en una sessió i obre una pull request. Revisa el commit exacte i la validació abans de fusionar. Desplegar és un pas separat.',
    importLead: 'Tria l’eina actual i els fitxers de configuració, un camí per línia. L’agent proposa la importació en una pull request. El desplegament actual continua funcionant.',
    workspace: 'On treballa l’agent', tool: 'Eina actual', paths: 'Camins dels fitxers de configuració',
    noWorkspace: 'Primer obre aquest projecte en una màquina i després tria aquí la seva còpia de treball.',
  },
  de: {
    noRepository: "Dieses Projekt braucht ein Repository. Füge es vor der Vorbereitung eines Deployments seiner Quelle hinzu.",
    prepare: 'Mit einem Agenten vorbereiten', import: 'Aus einem anderen Tool importieren',
    lead: 'Ein Agent bereitet das Deployment in einer Sitzung vor und öffnet einen Pull Request. Prüfe den genauen Commit und seine Validierung vor dem Zusammenführen. Das Deployment ist ein eigener Schritt.',
    importLead: 'Wähle das bisherige Tool und die Konfigurationsdateien, einen Pfad pro Zeile. Der Agent schlägt den Import in einem Pull Request vor. Das bisherige Deployment läuft weiter.',
    workspace: 'Wo der Agent arbeitet', tool: 'Bisheriges Tool', paths: 'Pfade der Konfigurationsdateien',
    noWorkspace: 'Öffne dieses Projekt zuerst auf einer Maschine und wähle dann hier seine Arbeitskopie.',
  },
  'zh-Hans': {
    noRepository: "此项目需要仓库。请先在项目来源中添加仓库，再准备部署。",
    prepare: '让代理准备部署', import: '从其他工具导入',
    lead: '代理会在会话中准备部署并创建拉取请求。合并前请检查准确的提交及其验证结果。部署是独立的步骤。',
    importLead: '选择现有工具和配置文件，每行一个路径。代理会通过拉取请求提出导入方案。现有部署将继续运行。',
    workspace: '代理的工作位置', tool: '现有工具', paths: '配置文件路径', noWorkspace: '请先在一台机器上打开此项目，然后在这里选择工作副本。',
  },
  'zh-Hant': {
    noRepository: "此專案需要儲存庫。請先在專案來源中新增儲存庫，再準備部署。",
    prepare: '讓代理準備部署', import: '從其他工具匯入',
    lead: '代理會在工作階段中準備部署並建立提取要求。合併前請檢查確切的提交及其驗證結果。部署是獨立步驟。',
    importLead: '選擇現有工具與設定檔，每行一個路徑。代理會透過提取要求提出匯入方案。現有部署將繼續執行。',
    workspace: '代理的工作位置', tool: '現有工具', paths: '設定檔路徑', noWorkspace: '請先在一台機器上開啟此專案，再在這裡選擇工作副本。',
  },
  ja: {
    noRepository: "このプロジェクトにはリポジトリが必要です。デプロイの準備前にプロジェクトのソースに追加してください。",
    prepare: 'エージェントで準備', import: '別のツールからインポート',
    lead: 'エージェントがセッションでデプロイを準備し、プルリクエストを開きます。マージ前に正確なコミットと検証結果を確認してください。デプロイは別の操作です。',
    importLead: '現在のツールと設定ファイルを選び、パスを1行に1つ入力してください。エージェントがプルリクエストでインポートを提案します。現在のデプロイは稼働を続けます。',
    workspace: 'エージェントの作業場所', tool: '現在のツール', paths: '設定ファイルのパス', noWorkspace: 'まずマシンでこのプロジェクトを開き、ここで作業コピーを選択してください。',
  },
};
