import type { SupportedLanguage } from '../_all';

type RecommendationCopy = Readonly<{ stored: string; requiresRepository: string; unknown: string; existing: string; chooseMachine: string }>;

export const deploymentRecommendationTranslations = {
  "en": {
    "stored": "This is a stored definition. One of your Machines can run it as is.",
    "requiresRepository": "This platform deploys from a repository. Create an Environment that deploys from a repository, or run this stored definition on your own server.",
    "unknown": "Choose where it runs. This repository’s build requirements haven’t been inspected.",
    "existing": "Recommended: keep this Environment’s linked target.",
    "chooseMachine": "Add or choose an available Machine to run this definition."
  },
  "fr": {
    "stored": "Cette définition est enregistrée. L’une de vos Machines peut l’exécuter telle quelle.",
    "requiresRepository": "Cette plateforme déploie depuis un dépôt. Créez un environnement qui déploie depuis un dépôt, ou exécutez cette définition enregistrée sur votre propre serveur.",
    "unknown": "Choisissez où l’exécuter. Les besoins de construction de ce dépôt n’ont pas été inspectés.",
    "existing": "Recommandé : conserver la cible liée à cet environnement.",
    "chooseMachine": "Ajoutez ou choisissez une Machine disponible pour exécuter cette définition."
  },
  "de": {
    "stored": "Diese Definition ist gespeichert. Eine deiner Maschinen kann sie unverändert ausführen.",
    "requiresRepository": "Diese Plattform stellt aus einem Repository bereit. Erstelle eine Umgebung, die aus einem Repository bereitstellt, oder führe diese gespeicherte Definition auf deinem eigenen Server aus.",
    "unknown": "Wähle den Ausführungsort. Die Build-Anforderungen dieses Repositorys wurden noch nicht geprüft.",
    "existing": "Empfohlen: Das verknüpfte Ziel dieser Umgebung behalten.",
    "chooseMachine": "Füge eine verfügbare Maschine hinzu oder wähle eine aus, um diese Definition auszuführen."
  },
  "es": {
    "stored": "Esta definición está guardada. Una de tus Máquinas puede ejecutarla tal como está.",
    "requiresRepository": "Esta plataforma despliega desde un repositorio. Crea un entorno que despliegue desde un repositorio o ejecuta esta definición guardada en tu propio servidor.",
    "unknown": "Elige dónde se ejecuta. No se han inspeccionado los requisitos de compilación del repositorio.",
    "existing": "Recomendado: conservar el destino vinculado a este entorno.",
    "chooseMachine": "Añade o elige una Máquina disponible para ejecutar esta definición."
  },
  "it": {
    "stored": "Questa definizione è salvata. Una delle tue Macchine può eseguirla così com’è.",
    "requiresRepository": "Questa piattaforma distribuisce da un repository. Crea un ambiente che distribuisca da un repository oppure esegui questa definizione salvata sul tuo server.",
    "unknown": "Scegli dove eseguirla. I requisiti di compilazione del repository non sono stati esaminati.",
    "existing": "Consigliato: mantenere la destinazione collegata a questo ambiente.",
    "chooseMachine": "Aggiungi o scegli una Macchina disponibile per eseguire questa definizione."
  },
  "pt": {
    "stored": "Esta definição está guardada. Uma das suas Máquinas pode executá-la tal como está.",
    "requiresRepository": "Esta plataforma faz a implantação a partir de um repositório. Crie um ambiente que use um repositório para a implantação ou execute esta definição guardada no seu próprio servidor.",
    "unknown": "Escolha onde executar. Os requisitos de compilação deste repositório não foram inspecionados.",
    "existing": "Recomendado: manter o destino associado a este ambiente.",
    "chooseMachine": "Adicione ou escolha uma Máquina disponível para executar esta definição."
  },
  "ca": {
    "stored": "Aquesta definició està desada. Una de les teves Màquines pot executar-la tal com està.",
    "requiresRepository": "Aquesta plataforma desplega des d’un repositori. Crea un entorn que desplegui des d’un repositori o executa aquesta definició desada al teu propi servidor.",
    "unknown": "Tria on s’executa. No s’han inspeccionat els requisits de compilació del repositori.",
    "existing": "Recomanat: conserva la destinació vinculada a aquest entorn.",
    "chooseMachine": "Afegeix o tria una Màquina disponible per executar aquesta definició."
  },
  "ru": {
    "stored": "Это сохранённое определение. Одна из ваших машин может запустить его как есть.",
    "requiresRepository": "Эта платформа развёртывает из репозитория. Создайте окружение, которое развёртывается из репозитория, или запустите это сохранённое определение на своём сервере.",
    "unknown": "Выберите место запуска. Требования к сборке этого репозитория ещё не проверены.",
    "existing": "Рекомендуется: сохранить связанную цель этого окружения.",
    "chooseMachine": "Добавьте или выберите доступную Машину для запуска этого описания."
  },
  "pl": {
    "stored": "To zapisana definicja. Jedna z Twoich Maszyn może ją uruchomić w obecnej postaci.",
    "requiresRepository": "Ta platforma wdraża z repozytorium. Utwórz środowisko wdrażane z repozytorium lub uruchom tę zapisaną definicję na własnym serwerze.",
    "unknown": "Wybierz miejsce uruchomienia. Wymagania kompilacji tego repozytorium nie zostały sprawdzone.",
    "existing": "Zalecane: zachowaj cel powiązany z tym środowiskiem.",
    "chooseMachine": "Dodaj lub wybierz dostępną Maszynę, aby uruchomić tę definicję."
  },
  "ja": {
    "stored": "保存済みの定義です。いずれかのマシンでそのまま実行できます。",
    "requiresRepository": "このプラットフォームはリポジトリからデプロイします。リポジトリからデプロイする環境を作成するか、この保存済みの定義を自分のサーバーで実行してください。",
    "unknown": "実行場所を選んでください。このリポジトリのビルド要件はまだ確認されていません。",
    "existing": "推奨：この環境にリンクされたターゲットを維持します。",
    "chooseMachine": "この定義を実行する利用可能なマシンを追加または選択してください。"
  },
  "zh-Hans": {
    "stored": "这是已保存的定义。你的一台机器可以按原样运行它。",
    "requiresRepository": "此平台从仓库部署。请创建一个从仓库部署的环境，或在你自己的服务器上运行此已保存的定义。",
    "unknown": "选择运行位置。尚未检查此仓库的构建要求。",
    "existing": "推荐：保留此环境已关联的目标。",
    "chooseMachine": "添加或选择可用的机器来运行此定义。"
  },
  "zh-Hant": {
    "stored": "這是已儲存的定義。你的一台機器可以原樣執行它。",
    "requiresRepository": "此平台從儲存庫部署。請建立一個從儲存庫部署的環境，或在你自己的伺服器上執行此已儲存的定義。",
    "unknown": "選擇執行位置。尚未檢查此儲存庫的建置需求。",
    "existing": "建議：保留此環境已連結的目標。",
    "chooseMachine": "新增或選擇可用的機器來執行此定義。"
  }
} satisfies Record<SupportedLanguage, RecommendationCopy>;
