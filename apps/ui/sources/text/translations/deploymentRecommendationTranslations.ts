import type { SupportedLanguage } from '../_all';

type RecommendationCopy = Readonly<{ stored: string; unknown: string; existing: string; chooseMachine: string }>;

export const deploymentRecommendationTranslations = {
  "en": {
    "stored": "It has no repository to build, so one of your Machines runs it as is.",
    "unknown": "Choose where it runs. This repository’s build requirements haven’t been inspected.",
    "existing": "Recommended: keep this Environment’s linked target.",
    "chooseMachine": "Add or choose an available Machine to run this definition."
  },
  "fr": {
    "stored": "Il n’a pas de dépôt à construire, donc une de vos Machines l’exécute tel quel.",
    "unknown": "Choisissez où l’exécuter. Les besoins de construction de ce dépôt n’ont pas été inspectés.",
    "existing": "Recommandé : conserver la cible liée à cet environnement.",
    "chooseMachine": "Ajoutez ou choisissez une Machine disponible pour exécuter cette définition."
  },
  "de": {
    "stored": "Es gibt kein Repository zu bauen, also führt eine deiner Maschinen es unverändert aus.",
    "unknown": "Wähle den Ausführungsort. Die Build-Anforderungen dieses Repositorys wurden noch nicht geprüft.",
    "existing": "Empfohlen: Das verknüpfte Ziel dieser Umgebung behalten.",
    "chooseMachine": "Füge eine verfügbare Maschine hinzu oder wähle eine aus, um diese Definition auszuführen."
  },
  "es": {
    "stored": "No tiene un repositorio que construir, así que una de tus Máquinas lo ejecuta tal cual.",
    "unknown": "Elige dónde se ejecuta. No se han inspeccionado los requisitos de compilación del repositorio.",
    "existing": "Recomendado: conservar el destino vinculado a este entorno.",
    "chooseMachine": "Añade o elige una Máquina disponible para ejecutar esta definición."
  },
  "it": {
    "stored": "Non ha un repository da compilare, quindi una delle tue Macchine lo esegue così com’è.",
    "unknown": "Scegli dove eseguirla. I requisiti di compilazione del repository non sono stati esaminati.",
    "existing": "Consigliato: mantenere la destinazione collegata a questo ambiente.",
    "chooseMachine": "Aggiungi o scegli una Macchina disponibile per eseguire questa definizione."
  },
  "pt": {
    "stored": "Não tem repositório para compilar, então uma das suas Máquinas o executa como está.",
    "unknown": "Escolha onde executar. Os requisitos de compilação deste repositório não foram inspecionados.",
    "existing": "Recomendado: manter o destino associado a este ambiente.",
    "chooseMachine": "Adicione ou escolha uma Máquina disponível para executar esta definição."
  },
  "ca": {
    "stored": "No té cap repositori per construir, així que una de les teves Màquines l’executa tal qual.",
    "unknown": "Tria on s’executa. No s’han inspeccionat els requisits de compilació del repositori.",
    "existing": "Recomanat: conserva la destinació vinculada a aquest entorn.",
    "chooseMachine": "Afegeix o tria una Màquina disponible per executar aquesta definició."
  },
  "ru": {
    "stored": "Собирать из репозитория нечего, поэтому одна из ваших Машин запускает его как есть.",
    "unknown": "Выберите место запуска. Требования к сборке этого репозитория ещё не проверены.",
    "existing": "Рекомендуется: сохранить связанную цель этого окружения.",
    "chooseMachine": "Добавьте или выберите доступную Машину для запуска этого описания."
  },
  "pl": {
    "stored": "Nie ma repozytorium do zbudowania, więc jedna z Twoich Maszyn uruchamia go bez zmian.",
    "unknown": "Wybierz miejsce uruchomienia. Wymagania kompilacji tego repozytorium nie zostały sprawdzone.",
    "existing": "Zalecane: zachowaj cel powiązany z tym środowiskiem.",
    "chooseMachine": "Dodaj lub wybierz dostępną Maszynę, aby uruchomić tę definicję."
  },
  "ja": {
    "stored": "ビルドするリポジトリがないため、あなたのマシンのいずれかがそのまま実行します。",
    "unknown": "実行場所を選んでください。このリポジトリのビルド要件はまだ確認されていません。",
    "existing": "推奨：この環境にリンクされたターゲットを維持します。",
    "chooseMachine": "この定義を実行する利用可能なマシンを追加または選択してください。"
  },
  "zh-Hans": {
    "stored": "没有需要构建的仓库，因此由你的一台机器按原样运行。",
    "unknown": "选择运行位置。尚未检查此仓库的构建要求。",
    "existing": "推荐：保留此环境已关联的目标。",
    "chooseMachine": "添加或选择可用的机器来运行此定义。"
  },
  "zh-Hant": {
    "stored": "沒有需要建置的儲存庫，因此由你的一台機器按原樣執行。",
    "unknown": "選擇執行位置。尚未檢查此儲存庫的建置需求。",
    "existing": "建議：保留此環境已連結的目標。",
    "chooseMachine": "新增或選擇可用的機器來執行此定義。"
  }
} satisfies Record<SupportedLanguage, RecommendationCopy>;
